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
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MockAnthropicServer,
  type RequestLogEntry,
} from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

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
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return []
  return lastUserMsg.content.filter(c => c.type === 'tool_result') as Array<{
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
  let session: TmuxSession

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
  })

  describe('Basic Tools', () => {
    test('basic Bash, Read, Edit, and Write tool results', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "hello from bash"' } },
        ]),
        textResponse('Done'),
      ])
      await session.submitAndApprove('Run echo hello')
      let log = await waitForRequestCount(server, 2, {
        description: 'Bash success tool_result request',
      })
      let toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)
      expect(resultContentString(toolResults[0])).toContain('hello from bash')

      server.reset([
        toolUseResponse([{ name: 'Bash', input: { command: 'exit 1' } }]),
        textResponse('Command failed'),
      ])
      await session.submitAndApprove('Run failing command')
      log = await waitForRequestCount(server, 2, {
        description: 'Bash failure tool_result request',
      })
      toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).toBe(true)

      const readFilePath = join(session.cwd, 'test-read.txt')
      await writeFile(
        readFilePath,
        'Read integration test content line one\nLine two',
      )
      server.reset([
        toolUseResponse([{ name: 'Read', input: { file_path: readFilePath } }]),
        textResponse('File read successfully'),
      ])
      await session.submitAndApprove('Read the test file')
      log = await waitForRequestCount(server, 2, {
        description: 'Read tool_result request',
      })
      toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)
      const readContent = resultContentString(toolResults[0])
      expect(readContent).toContain('Read integration test content line one')
      expect(readContent).toContain('Line two')

      const editFilePath = join(session.cwd, 'test-edit.txt')
      await writeFile(
        editFilePath,
        'The quick brown fox jumps over the lazy dog.',
      )
      server.reset([
        toolUseResponse([{ name: 'Read', input: { file_path: editFilePath } }]),
        toolUseResponse([
          {
            name: 'Edit',
            input: {
              file_path: editFilePath,
              old_string: 'quick brown fox',
              new_string: 'slow red turtle',
            },
          },
        ]),
        textResponse('Edit complete'),
      ])
      await session.submitAndApprove('Edit the file')
      log = await waitForRequestCount(server, 3, {
        description: 'Edit tool_result request',
      })
      toolResults = getToolResults(log, 2)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)
      const editedContent = await readFile(editFilePath, 'utf-8')
      expect(editedContent).toContain('slow red turtle')
      expect(editedContent).not.toContain('quick brown fox')

      const newFile = join(session.cwd, 'newly-written.txt')
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
      await session.submitAndApprove('Write a new file')
      log = await waitForRequestCount(server, 2, {
        description: 'Write tool_result request',
      })
      toolResults = getToolResults(log)
      expect(toolResults.length).toBe(1)
      expect(toolResults[0].is_error).not.toBe(true)
      const fileContent = await readFile(newFile, 'utf-8')
      expect(fileContent).toContain('This file was created by the Write tool.')
      expect(fileContent).toContain('Second line.')
    })
  })

  // Grep/Glob tools are feature-gated behind DEDICATED_SEARCH_TOOLS and
  // stripped from the default tool registry (see shouldPreferBashForSearch()
  // in src/utils/embeddedTools.ts — default builds steer search through Bash
  // via `find` / `grep` / `rg`). Config tool was removed entirely in c07726a.
  // Tests for those registrations were deleted along with the tools.

  describe('Parallel Tool Calls', () => {
    test('parallel Bash and file tools return all tool_results', async () => {
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
      await session.submitAndApprove('Run bash and read file')
      let log = await waitForRequestCount(server, 2, {
        description: 'Bash + Read parallel tool_result request',
      })
      let toolResults = getToolResults(log)
      expect(toolResults.length).toBe(2)
      for (const tr of toolResults) {
        expect(tr.is_error).not.toBe(true)
      }
      const allContent = toolResults
        .map(tr => resultContentString(tr))
        .join('\n')
      expect(allContent).toContain('parallel_bash_output')
      expect(allContent).toContain('parallel read content')

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "parallel_a"' } },
          { name: 'Bash', input: { command: 'echo "parallel_b"' } },
        ]),
        textResponse('Both parallel commands completed'),
      ])
      await session.submitAndApprove('Run two commands in parallel')
      log = await waitForRequestCount(server, 2, {
        description: 'two parallel Bash tool_result request',
      })
      toolResults = getToolResults(log)
      expect(toolResults.length).toBe(2)

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "one"' } },
          { name: 'Bash', input: { command: 'echo "two"' } },
          { name: 'Bash', input: { command: 'echo "three"' } },
        ]),
        textResponse('All three completed'),
      ])
      await session.submitAndApprove('Run three commands')
      log = await waitForRequestCount(server, 2, {
        description: 'three parallel Bash tool_result request',
      })
      toolResults = getToolResults(log)
      expect(toolResults.length).toBe(3)
    })

    test('parallel mixed failure and sequential follow-up are handled', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "success"' } },
          { name: 'Bash', input: { command: 'false' } },
        ]),
        textResponse('One command succeeded and one failed'),
      ])
      await session.submitAndApprove('Run mixed commands')
      let log = await waitForRequestCount(server, 2, {
        description: 'mixed parallel Bash tool_result request',
      })
      let toolResults = getToolResults(log)
      expect(toolResults.length).toBe(2)

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "p1"' } },
          { name: 'Bash', input: { command: 'echo "p2"' } },
        ]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "seq"' } }]),
        textResponse('All done: p1, p2, seq'),
      ])
      await session.submitAndApprove('Run parallel then sequential')
      log = await waitForRequestCount(server, 3, {
        description: 'parallel then sequential tool requests',
      })
      expect(log.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('Parallel Agent Tool Calls', () => {
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
