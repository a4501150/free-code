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
import { writeFile, readFile } from 'node:fs/promises'
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

  // Grep/Glob tools are feature-gated behind DEDICATED_SEARCH_TOOLS and
  // stripped from the default tool registry (see shouldPreferBashForSearch()
  // in src/utils/embeddedTools.ts — default builds steer search through Bash
  // via `find` / `grep` / `rg`). Config tool was removed entirely in c07726a.
  // Tests for those registrations were deleted along with the tools.

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

  // ─── Parallel Agent Tool Calls ────────────────────

  describe('Parallel Agent Tool Calls', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('multiple concurrent agents complete without infinite re-render crash', async () => {
      // Regression test: GroupedAgentToolUseView renders a live timer via
      // useNow() when multiple agents run concurrently. A broken getSnapshot
      // (returning Date.now() directly to useSyncExternalStore) caused
      // "Maximum update depth exceeded" and crashed the CLI.
      //
      // Response queue:
      //   0: main → 2 parallel Agent tool_use blocks
      //   1: subagent 1 text response
      //   2: subagent 2 text response
      //   3: main → final text after collecting agent results
      server.reset([
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'First parallel task',
              prompt: 'Return the word hello',
            },
          },
          {
            name: 'Agent',
            input: {
              description: 'Second parallel task',
              prompt: 'Return the word world',
            },
          },
        ]),
        textResponse('hello'),
        textResponse('world'),
        textResponse('Both agents finished successfully'),
      ])

      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // If the useNow bug is present, the CLI crashes during grouped agent
      // rendering and never returns to idle — submitAndApprove times out.
      const screen = await session.submitAndApprove(
        'Run two agents in parallel',
        90_000,
      )

      // Verify no crash error appeared in the terminal
      expect(screen).not.toContain('Maximum update depth exceeded')

      // Verify the main agent completed at least one round-trip
      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)
    })
  })
})
