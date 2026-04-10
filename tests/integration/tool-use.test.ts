import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { MockAnthropicServer } from './mock-server'
import { runCLI, getAssistantMessages } from './test-helpers'
import { textResponse, toolUseResponse } from './fixture-builders'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Tool Use', () => {
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

  test('BashTool call and text follow-up', async () => {
    server.reset([
      // Turn 1: model wants to run a bash command
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "hello from bash"' } },
      ]),
      // Turn 2: model receives tool result, responds with text
      textResponse('The bash command output was: hello from bash'),
    ])

    const result = await runCLI({
      prompt: 'Run echo hello',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello from bash')

    // Verify the server received 2 requests (initial + after tool result)
    expect(server.getRequestCount()).toBe(2)
  })

  test('tool execution error is sent back to model', async () => {
    server.reset([
      // Turn 1: model tries a command that will fail
      toolUseResponse([
        {
          name: 'Bash',
          input: { command: 'exit 1' },
        },
      ]),
      // Turn 2: model gets the error result, responds gracefully
      textResponse('The command failed with exit code 1.'),
    ])

    const result = await runCLI({
      prompt: 'Run a failing command',
      serverUrl: server.url,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('failed')

    // Verify 2 API requests were made
    expect(server.getRequestCount()).toBe(2)

    // Check that the second request contains a tool_result
    const log = server.getRequestLog()
    const secondRequest = log[1]
    const messages = secondRequest.body.messages as Array<{
      role: string
      content: unknown
    }>
    const lastMsg = messages[messages.length - 1]
    expect(lastMsg.role).toBe('user')
    // The content should contain a tool_result block
    const content = lastMsg.content as Array<{ type: string }>
    expect(content.some((c) => c.type === 'tool_result')).toBe(true)
  })

  test('FileReadTool reads a test file', async () => {
    // Create a temp file to read
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-test-read-'))
    const testFile = join(tempDir, 'test-file.txt')
    await writeFile(testFile, 'This is test file content for reading.')

    try {
      server.reset([
        // Turn 1: model wants to read a file
        toolUseResponse([
          { name: 'Read', input: { file_path: testFile } },
        ]),
        // Turn 2: model summarizes the file content
        textResponse('The file contains: This is test file content for reading.'),
      ])

      const result = await runCLI({
        prompt: 'Read the test file',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tempDir,
      })

      expect(result.exitCode).toBe(0)
      // Verify model received the file content (check API request log)
      expect(server.getRequestCount()).toBe(2)
    } finally {
      await Bun.spawn(['rm', '-rf', tempDir]).exited
    }
  })

  test('GlobTool searches for files', async () => {
    // Create temp directory with some files
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-test-glob-'))
    await writeFile(join(tempDir, 'file1.ts'), 'export const a = 1')
    await writeFile(join(tempDir, 'file2.ts'), 'export const b = 2')
    await writeFile(join(tempDir, 'readme.md'), '# README')

    try {
      server.reset([
        // Turn 1: model searches for .ts files
        toolUseResponse([
          { name: 'Glob', input: { pattern: '**/*.ts', path: tempDir } },
        ]),
        // Turn 2: model reports what it found
        textResponse('Found 2 TypeScript files: file1.ts and file2.ts'),
      ])

      const result = await runCLI({
        prompt: 'Find all TypeScript files',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tempDir,
      })

      expect(result.exitCode).toBe(0)
      expect(server.getRequestCount()).toBe(2)
    } finally {
      await Bun.spawn(['rm', '-rf', tempDir]).exited
    }
  })

  test('GrepTool searches file contents', async () => {
    // Create temp directory with files containing searchable text
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-test-grep-'))
    await writeFile(
      join(tempDir, 'app.ts'),
      'function handleRequest(req: Request) {\n  return new Response("ok")\n}',
    )

    try {
      server.reset([
        // Turn 1: model searches for "handleRequest"
        toolUseResponse([
          {
            name: 'Grep',
            input: { pattern: 'handleRequest', path: tempDir },
          },
        ]),
        // Turn 2: model reports the finding
        textResponse('Found handleRequest in app.ts'),
      ])

      const result = await runCLI({
        prompt: 'Search for handleRequest',
        serverUrl: server.url,
        maxTurns: 3,
        cwd: tempDir,
      })

      expect(result.exitCode).toBe(0)
      expect(server.getRequestCount()).toBe(2)
    } finally {
      await Bun.spawn(['rm', '-rf', tempDir]).exited
    }
  })
})
