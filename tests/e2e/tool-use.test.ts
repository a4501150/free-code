/**
 * Tool Use E2E Tests
 *
 * Tests all tool functionality through the interactive REPL via tmux.
 * Verifies tool results via the mock server's request log and disk side effects.
 * Permission dialogs are approved via submitAndApprove() — testing the real
 * permission pipeline end-to-end.
 *
 * Combines coverage from the old integration tool-use.test.ts and
 * parallel-tools.test.ts into a single e2e suite.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'bun:test'
import {
  MockAnthropicServer,
  type RequestLogEntry,
} from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// ── Helpers ──────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────

describe('Tool Use E2E', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  // ─── Bash ───────────────────────────────────────────────

  describe('Bash', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('successful command returns output, is_error false', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "hello from bash"' } },
        ]),
        textResponse('Done'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Run echo hello')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('hello from bash')
    })

    test('failed command sets is_error', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'exit 1' } },
        ]),
        textResponse('Command failed'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Run failing command')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).toBe(true)
    })
  })

  // ─── Read ───────────────────────────────────────────────

  describe('Read', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('reads file content correctly', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const testFile = join(session.cwd, 'test-read.txt')
      await writeFile(
        testFile,
        'Read integration test content line one\nLine two',
      )

      server.reset([
        toolUseResponse([
          { name: 'Read', input: { file_path: testFile } },
        ]),
        textResponse('File read successfully'),
      ])

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Read the test file')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('Read integration test content line one')
      expect(content).toContain('Line two')
    })
  })

  // ─── Edit ───────────────────────────────────────────────

  describe('Edit', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('replaces string in file and verifies disk change', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const testFile = join(session.cwd, 'test-edit.txt')
      await writeFile(
        testFile,
        'The quick brown fox jumps over the lazy dog.',
      )

      // Read first (required before Edit), then Edit, then text
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

      // 2 tool calls (Read + Edit) → 2 permission approvals
      await session.submitAndApprove('Edit the file')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(3)

      // Check the Edit tool result (3rd request, index 2)
      const toolResults = getToolResults(log, 2)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      // Verify the file was actually changed on disk
      const fileContent = await readFile(testFile, 'utf-8')
      expect(fileContent).toContain('slow red turtle')
      expect(fileContent).not.toContain('quick brown fox')
    })
  })

  // ─── Write ──────────────────────────────────────────────

  describe('Write', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('creates new file with content', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const newFile = join(session.cwd, 'newly-written.txt')

      server.reset([
        toolUseResponse([
          {
            name: 'Write',
            input: {
              file_path: newFile,
              content:
                'This file was created by the Write tool.\nSecond line.',
            },
          },
        ]),
        textResponse('File written'),
      ])

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Write a new file')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      // Verify the file exists on disk with expected content
      const fileContent = await readFile(newFile, 'utf-8')
      expect(fileContent).toContain(
        'This file was created by the Write tool.',
      )
      expect(fileContent).toContain('Second line.')
    })
  })

  // ─── Grep ──────────────────────────────────────────────

  describe('Grep', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('finds matching files and content', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await writeFile(
        join(session.cwd, 'app.ts'),
        'function handleRequest(req: Request) {\n  return new Response("ok")\n}',
      )
      await writeFile(
        join(session.cwd, 'utils.ts'),
        'export function helperFunction() { return 42 }',
      )

      server.reset([
        toolUseResponse([
          {
            name: 'Grep',
            input: { pattern: 'handleRequest', path: session.cwd },
          },
        ]),
        textResponse('Found handleRequest'),
      ])

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Search for handleRequest')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('app.ts')
      expect(content).not.toContain('utils.ts')
    })

    test('searches with regex pattern', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await writeFile(
        join(session.cwd, 'data.ts'),
        'const userId = 42\nconst userName = "Alice"\nconst userEmail = "alice@example.com"',
      )
      await writeFile(
        join(session.cwd, 'config.ts'),
        'const port = 3000\nconst host = "localhost"',
      )

      server.reset([
        toolUseResponse([
          {
            name: 'Grep',
            input: { pattern: 'user\\w+', path: session.cwd },
          },
        ]),
        textResponse('Found user-related variables'),
      ])

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Search for user variables')

      const log = server.getRequestLog()
      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('data.ts')
    })
  })

  // ─── Glob ──────────────────────────────────────────────

  describe('Glob', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('finds files matching pattern', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await writeFile(join(session.cwd, 'file1.ts'), 'export const a = 1')
      await writeFile(join(session.cwd, 'file2.ts'), 'export const b = 2')
      await writeFile(join(session.cwd, 'readme.md'), '# README')

      server.reset([
        toolUseResponse([
          { name: 'Glob', input: { pattern: '**/*.ts', path: session.cwd } },
        ]),
        textResponse('Found TypeScript files'),
      ])

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Find all TypeScript files')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('file1.ts')
      expect(content).toContain('file2.ts')
      expect(content).not.toContain('readme.md')
    })

    test('finds files in nested directories', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const subDir = join(session.cwd, 'src', 'components')
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
        join(session.cwd, 'src', 'index.ts'),
        'export * from "./components"',
      )

      server.reset([
        toolUseResponse([
          {
            name: 'Glob',
            input: { pattern: '**/*.tsx', path: session.cwd },
          },
        ]),
        textResponse('Found TSX files'),
      ])

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Find TSX files')

      const log = server.getRequestLog()
      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content).toContain('Button.tsx')
      expect(content).toContain('Input.tsx')
      expect(content).not.toContain('index.ts')
    })
  })

  // ─── NotebookEdit ─────────────────────────────────────

  describe('NotebookEdit', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('edits a cell in a .ipynb notebook', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const notebookFile = join(session.cwd, 'test-notebook.ipynb')
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

      // Read first (required), then NotebookEdit, then text
      server.reset([
        toolUseResponse([
          { name: 'Read', input: { file_path: notebookFile } },
        ]),
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

      // 2 tool calls (Read + NotebookEdit) → 2 permission approvals
      await session.submitAndApprove('Edit the notebook cell')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(3)

      // Check NotebookEdit tool result (3rd request, index 2)
      const toolResults = getToolResults(log, 2)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      // Verify notebook changed on disk
      const updatedContent = JSON.parse(
        await readFile(notebookFile, 'utf-8'),
      )
      const cell = updatedContent.cells.find(
        (c: { id: string }) => c.id === 'cell-001',
      )
      expect(cell).toBeDefined()
      const source = Array.isArray(cell.source)
        ? cell.source.join('')
        : cell.source
      expect(source).toContain('edited content')
    })
  })

  // ─── Config ────────────────────────────────────────────

  describe('Config', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('reads a setting value', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Config', input: { setting: 'theme' } },
        ]),
        textResponse('The theme setting value'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('What is the current theme?')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)

      const content = resultContentString(toolResults[0])
      expect(content.length).toBeGreaterThan(0)
    })
  })

  // ─── Parallel Tool Calls ──────────────────────────────

  describe('Parallel Tool Calls', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('Bash + Read: both results returned correctly', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      const testFile = join(session.cwd, 'parallel-read.txt')
      await writeFile(testFile, 'parallel read content')

      server.reset([
        toolUseResponse([
          {
            name: 'Bash',
            input: { command: 'echo "parallel_bash_output"' },
          },
          { name: 'Read', input: { file_path: testFile } },
        ]),
        textResponse('Both tools completed'),
      ])

      // 2 parallel tool calls → 2 permission approvals
      await session.submitAndApprove('Run bash and read file')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const toolResults = getToolResults(log)
      expect(toolResults.length).toBe(2)

      for (const tr of toolResults) {
        expect(tr.is_error).not.toBe(true)
      }

      const allContent = toolResults
        .map((tr) => resultContentString(tr))
        .join('\n')
      expect(allContent).toContain('parallel_bash_output')
      expect(allContent).toContain('parallel read content')
    })

    test('two parallel Bash calls', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "parallel_a"' } },
          { name: 'Bash', input: { command: 'echo "parallel_b"' } },
        ]),
        textResponse(
          'Both parallel commands completed: parallel_a and parallel_b',
        ),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 2 parallel tool calls → 2 permission approvals
      await session.submitAndApprove('Run two commands in parallel')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const secondRequest = log[1]
      const messages = secondRequest.body.messages as Array<{
        role: string
        content: unknown
      }>
      const lastMsg = messages[messages.length - 1]
      expect(lastMsg.role).toBe('user')
      const content = lastMsg.content as Array<{ type: string }>
      const toolResults = content.filter((c) => c.type === 'tool_result')
      expect(toolResults.length).toBe(2)
    })

    test('three parallel tool calls', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "one"' } },
          { name: 'Bash', input: { command: 'echo "two"' } },
          { name: 'Bash', input: { command: 'echo "three"' } },
        ]),
        textResponse('All three completed'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 3 parallel tool calls → 3 permission approvals
      await session.submitAndApprove('Run three commands')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const secondRequest = log[1]
      const messages = secondRequest.body.messages as Array<{
        role: string
        content: unknown
      }>
      const lastMsg = messages[messages.length - 1]
      const content = lastMsg.content as Array<{ type: string }>
      const toolResults = content.filter((c) => c.type === 'tool_result')
      expect(toolResults.length).toBe(3)
    })

    test('mixed parallel: one succeeds, one fails', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "success"' } },
          { name: 'Bash', input: { command: 'false' } },
        ]),
        textResponse('One command succeeded and one failed'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 2 parallel tool calls → 2 permission approvals
      await session.submitAndApprove('Run mixed commands')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const secondRequest = log[1]
      const messages = secondRequest.body.messages as Array<{
        role: string
        content: unknown
      }>
      const lastMsg = messages[messages.length - 1]
      const content = lastMsg.content as Array<{
        type: string
        is_error?: boolean
      }>
      const toolResults = content.filter((c) => c.type === 'tool_result')
      expect(toolResults.length).toBe(2)
    })

    test('parallel tools followed by sequential tool', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "p1"' } },
          { name: 'Bash', input: { command: 'echo "p2"' } },
        ]),
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "seq"' } },
        ]),
        textResponse('All done: p1, p2, seq'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 2 parallel + 1 sequential = 3 permission approvals
      await session.submitAndApprove('Run parallel then sequential')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(3)
    })
  })
})
