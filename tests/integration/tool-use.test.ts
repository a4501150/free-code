import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test'
import { MockAnthropicServer, type RequestLogEntry } from './mock-server'
import { runCLI, createTempDir } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Extract tool_result block(s) from a specific request in the mock server log.
 * By default looks at the second request (index 1), which is where tool results
 * appear after the first tool_use response.
 */
function getToolResults(
  log: RequestLogEntry[],
  requestIndex = 1,
): Array<{
  type: string
  tool_use_id: string
  content: unknown
  is_error?: boolean
}> {
  const messages = log[requestIndex].body.messages as Array<{
    role: string
    content: Array<{
      type: string
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }>
  }>
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return []
  return lastUserMsg.content.filter((c) => c.type === 'tool_result') as Array<{
    type: string
    tool_use_id: string
    content: unknown
    is_error?: boolean
  }>
}

/**
 * Stringify the content field of a tool_result for assertion matching.
 */
function resultContentString(
  toolResult: { content: unknown } | undefined,
): string {
  if (!toolResult) return ''
  const c = toolResult.content
  if (typeof c === 'string') return c
  return JSON.stringify(c)
}

describe('Tool Use — Full Coverage with Result Verification', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  beforeEach(() => {
    server.reset([])
  })

  // ─── Bash ───────────────────────────────────────────────

  test('Bash: successful command returns output, is_error false', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "hello from bash"' } },
      ]),
      textResponse('Done'),
    ])

    const result = await runCLI({
      prompt: 'Run echo hello',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)

    const log = server.getRequestLog()
    expect(log.length).toBe(2)

    const toolResults = getToolResults(log)
    expect(toolResults.length).toBe(1)
    expect(toolResults[0].is_error).not.toBe(true)

    const content = resultContentString(toolResults[0])
    expect(content).toContain('hello from bash')
  })

  test('Bash: failed command sets is_error', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'exit 1' } },
      ]),
      textResponse('Command failed'),
    ])

    const result = await runCLI({
      prompt: 'Run failing command',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)

    const log = server.getRequestLog()
    expect(log.length).toBe(2)

    const toolResults = getToolResults(log)
    expect(toolResults.length).toBe(1)
    // A non-zero exit code should result in is_error being set
    expect(toolResults[0].is_error).toBe(true)
  })

  // ─── Read ───────────────────────────────────────────────

  test('Read: reads file content correctly', async () => {
    const tmp = await createTempDir()
    const testFile = join(tmp.path, 'test-read.txt')
    await writeFile(testFile, 'Read integration test content line one\nLine two')

    try {
      server.reset([
        toolUseResponse([
          { name: 'Read', input: { file_path: testFile } },
        ]),
        textResponse('File read successfully'),
      ])

      const result = await runCLI({
        prompt: 'Read the test file',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('Read integration test content line one')
      expect(content).toContain('Line two')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Edit ───────────────────────────────────────────────

  test('Edit: replaces string in file and verifies disk change', async () => {
    const tmp = await createTempDir()
    const testFile = join(tmp.path, 'test-edit.txt')
    await writeFile(testFile, 'The quick brown fox jumps over the lazy dog.')

    try {
      // First response: Read (required before Edit)
      // Second response: Edit
      // Third response: final text
      server.reset([
        toolUseResponse([
          { name: 'Read', input: { file_path: testFile } },
        ]),
        toolUseResponse([
          {
            name: 'Edit',
            input: {
              file_path: testFile,
              old_string: 'quick brown fox',
              new_string: 'slow red turtle',
            },
          },
        ]),
        textResponse('Edit complete'),
      ])

      const result = await runCLI({
        prompt: 'Edit the file',
        serverUrl: server.url,
        maxTurns: 5,
        cwd: tmp.path,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(3)

      // Check the Edit tool result (in the 3rd request, index 2)
      const toolResults = getToolResults(log, 2)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      // Verify the file was actually changed on disk
      const fileContent = await readFile(testFile, 'utf-8')
      expect(fileContent).toContain('slow red turtle')
      expect(fileContent).not.toContain('quick brown fox')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Write (requires fullTools) ─────────────────────────

  test('Write: creates new file with content', async () => {
    const tmp = await createTempDir()
    const newFile = join(tmp.path, 'newly-written.txt')

    try {
      server.reset([
        toolUseResponse([
          {
            name: 'Write',
            input: {
              file_path: newFile,
              content: 'This file was created by the Write tool.\nSecond line.',
            },
          },
        ]),
        textResponse('File written'),
      ])

      const result = await runCLI({
        prompt: 'Write a new file',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
        fullTools: true,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      // Verify the file exists on disk with expected content
      const fileContent = await readFile(newFile, 'utf-8')
      expect(fileContent).toContain(
        'This file was created by the Write tool.',
      )
      expect(fileContent).toContain('Second line.')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Grep (requires fullTools) ──────────────────────────

  test('Grep: finds matching files and content', async () => {
    const tmp = await createTempDir()
    await writeFile(
      join(tmp.path, 'app.ts'),
      'function handleRequest(req: Request) {\n  return new Response("ok")\n}',
    )
    await writeFile(
      join(tmp.path, 'utils.ts'),
      'export function helperFunction() { return 42 }',
    )

    try {
      server.reset([
        toolUseResponse([
          {
            name: 'Grep',
            input: { pattern: 'handleRequest', path: tmp.path },
          },
        ]),
        textResponse('Found handleRequest'),
      ])

      const result = await runCLI({
        prompt: 'Search for handleRequest',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
        fullTools: true,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      // Should contain the matching file name
      expect(content).toContain('app.ts')
      // Should NOT contain the non-matching file
      expect(content).not.toContain('utils.ts')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Glob (requires fullTools) ──────────────────────────

  test('Glob: finds files matching pattern', async () => {
    const tmp = await createTempDir()
    await writeFile(join(tmp.path, 'file1.ts'), 'export const a = 1')
    await writeFile(join(tmp.path, 'file2.ts'), 'export const b = 2')
    await writeFile(join(tmp.path, 'readme.md'), '# README')

    try {
      server.reset([
        toolUseResponse([
          { name: 'Glob', input: { pattern: '**/*.ts', path: tmp.path } },
        ]),
        textResponse('Found TypeScript files'),
      ])

      const result = await runCLI({
        prompt: 'Find all TypeScript files',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
        fullTools: true,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      // Should contain the .ts files
      expect(content).toContain('file1.ts')
      expect(content).toContain('file2.ts')
      // Should NOT contain the .md file
      expect(content).not.toContain('readme.md')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── NotebookEdit (requires fullTools) ─────────────────

  test('NotebookEdit: edits a cell in a .ipynb notebook', async () => {
    const tmp = await createTempDir()
    const notebookFile = join(tmp.path, 'test-notebook.ipynb')

    // Create a minimal valid Jupyter notebook
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: 'Python 3',
          language: 'python',
          name: 'python3',
        },
        language_info: { name: 'python', version: '3.9.0' },
      },
      cells: [
        {
          cell_type: 'code',
          id: 'cell-001',
          metadata: {},
          source: ['print("original content")'],
          outputs: [],
          execution_count: null,
        },
        {
          cell_type: 'markdown',
          id: 'cell-002',
          metadata: {},
          source: ['# Original heading'],
        },
      ],
    }
    await writeFile(notebookFile, JSON.stringify(notebook, null, 2))

    try {
      // NotebookEdit requires a prior Read of the file (read-before-edit guard)
      server.reset([
        // Turn 1: Read the notebook first
        toolUseResponse([
          { name: 'Read', input: { file_path: notebookFile } },
        ]),
        // Turn 2: Now edit the cell
        toolUseResponse([
          {
            name: 'NotebookEdit',
            input: {
              notebook_path: notebookFile,
              cell_id: 'cell-001',
              new_source: 'print("edited content")',
            },
          },
        ]),
        textResponse('Notebook edited'),
      ])

      const result = await runCLI({
        prompt: 'Edit the notebook cell',
        serverUrl: server.url,
        maxTurns: 5,
        cwd: tmp.path,
        fullTools: true,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(3)

      // Check the NotebookEdit tool result (in the 3rd request, index 2)
      const toolResults = getToolResults(log, 2)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      // Verify the notebook file was changed on disk
      const updatedContent = JSON.parse(await readFile(notebookFile, 'utf-8'))
      const cell = updatedContent.cells.find(
        (c: { id: string }) => c.id === 'cell-001',
      )
      expect(cell).toBeDefined()
      const source = Array.isArray(cell.source)
        ? cell.source.join('')
        : cell.source
      expect(source).toContain('edited content')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Config (requires fullTools) ────────────────────────

  test('Config: reads a setting value', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Config', input: { setting: 'theme' } },
      ]),
      textResponse('The theme setting value'),
    ])

    const result = await runCLI({
      prompt: 'What is the current theme?',
      serverUrl: server.url,
      maxTurns: 3,
      fullTools: true,
    })

    expect(result.exitCode).toBe(0)

    const log = server.getRequestLog()
    expect(log.length).toBe(2)

    const toolResults = getToolResults(log)
    expect(toolResults.length).toBe(1)
    expect(toolResults[0].is_error).not.toBe(true)

    // Config tool should return something (the setting value or a description)
    const content = resultContentString(toolResults[0])
    expect(content.length).toBeGreaterThan(0)
  })

  // ─── Glob nested directories (requires fullTools) ──────

  test('Glob: finds files in nested directories', async () => {
    const tmp = await createTempDir()
    const subDir = join(tmp.path, 'src', 'components')
    await mkdir(subDir, { recursive: true })
    await writeFile(
      join(subDir, 'Button.tsx'),
      'export const Button = () => {}',
    )
    await writeFile(
      join(subDir, 'Input.tsx'),
      'export const Input = () => {}',
    )
    await writeFile(
      join(tmp.path, 'src', 'index.ts'),
      'export * from "./components"',
    )

    try {
      server.reset([
        toolUseResponse([
          { name: 'Glob', input: { pattern: '**/*.tsx', path: tmp.path } },
        ]),
        textResponse('Found TSX files'),
      ])

      const result = await runCLI({
        prompt: 'Find TSX files',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
        fullTools: true,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('Button.tsx')
      expect(content).toContain('Input.tsx')
      // Should NOT match .ts files
      expect(content).not.toContain('index.ts')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Grep regex (requires fullTools) ───────────────────

  test('Grep: searches with regex pattern', async () => {
    const tmp = await createTempDir()
    await writeFile(
      join(tmp.path, 'data.ts'),
      'const userId = 42\nconst userName = "Alice"\nconst userEmail = "alice@example.com"',
    )
    await writeFile(
      join(tmp.path, 'config.ts'),
      'const port = 3000\nconst host = "localhost"',
    )

    try {
      server.reset([
        toolUseResponse([
          {
            name: 'Grep',
            input: { pattern: 'user\\w+', path: tmp.path },
          },
        ]),
        textResponse('Found user-related variables'),
      ])

      const result = await runCLI({
        prompt: 'Search for user variables',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
        fullTools: true,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('data.ts')
    } finally {
      await tmp.cleanup()
    }
  })

  // ─── Parallel tool calls with result verification ──────

  test('Parallel Bash + Read: both results returned correctly', async () => {
    const tmp = await createTempDir()
    const testFile = join(tmp.path, 'parallel-read.txt')
    await writeFile(testFile, 'parallel read content')

    try {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "parallel_bash_output"' } },
          { name: 'Read', input: { file_path: testFile } },
        ]),
        textResponse('Both tools completed'),
      ])

      const result = await runCLI({
        prompt: 'Run bash and read file',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tmp.path,
      })

      expect(result.exitCode).toBe(0)

      const log = server.getRequestLog()
      expect(log.length).toBe(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(2)

      // Both results should not be errors
      for (const tr of toolResults) {
        expect(tr.is_error).not.toBe(true)
      }

      // Combine all result content for checking
      const allContent = toolResults
        .map((tr) => resultContentString(tr))
        .join('\n')
      expect(allContent).toContain('parallel_bash_output')
      expect(allContent).toContain('parallel read content')
    } finally {
      await tmp.cleanup()
    }
  })
})
