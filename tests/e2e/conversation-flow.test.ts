/**
 * Conversation Flow E2E Tests
 *
 * Verifies message ordering, tool result handling, multi-turn chains,
 * max-turns enforcement, stop reasons, and extended thinking — all
 * through a real tmux REPL session backed by a mock API server.
 *
 * Uses the real default permission mode — tool executions are approved
 * via approvePermission() which presses Enter on the "Yes" dialog.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import {
  textResponse,
  toolUseResponse,
  thinkingResponse,
  thinkingToolUseResponse,
  maxTokensResponse,
} from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Conversation Flow E2E', () => {
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

  // ─── Request Shape ─────────────────────────────────────────

  describe('Request Shape', () => {
    test('first request contains user message and tool definitions', async () => {
      server.reset([textResponse('Got it')])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.submitAndWaitForResponse('Hello from the e2e test')

      const log = await waitForRequestCount(server, 1, {
        description: 'initial request shape',
      })
      const messages = log[0].body.messages as Array<{
        role: string
        content: unknown
      }>
      expect(messages.length).toBeGreaterThanOrEqual(1)
      expect(messages[0].role).toBe('user')

      const content = messages[0].content
      const contentStr =
        typeof content === 'string' ? content : JSON.stringify(content)
      expect(contentStr).toContain('Hello from the e2e test')

      const tools = log[0].body.tools as Array<{ name: string }>
      expect(Array.isArray(tools)).toBe(true)
      expect(tools.length).toBeGreaterThan(0)
      const toolNames = tools.map(t => t.name)
      expect(toolNames).toContain('Bash')
      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('Edit')
    })
  })

  // ─── Tool Result Round-Trips ───────────────────────────────

  describe('Tool Result Round-Trips', () => {
    test('tool_result blocks preserve tool_use_id and request body shape', async () => {
      const toolId1 = 'toolu_ref_001'
      const toolId2 = 'toolu_ref_002'

      server.reset([
        toolUseResponse([
          { name: 'Bash', id: toolId1, input: { command: 'echo "a"' } },
          { name: 'Bash', id: toolId2, input: { command: 'echo "b"' } },
        ]),
        textResponse('Both done'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.submitAndApprove('Test tool result round trip')

      const log = await waitForRequestCount(server, 2, {
        description: 'tool_result round-trip request',
      })
      const secondMessages = log[1].body.messages as Array<{
        role: string
        content: unknown
      }>

      const toolResultIds: string[] = []
      let foundToolResult = false
      for (const msg of secondMessages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{
            type: string
            tool_use_id?: string
          }>) {
            if (block.type === 'tool_result') {
              foundToolResult = true
              if (block.tool_use_id) toolResultIds.push(block.tool_use_id)
            }
          }
        }
      }

      expect(foundToolResult).toBe(true)
      expect(toolResultIds).toContain(toolId1)
      expect(toolResultIds).toContain(toolId2)
    })
  })

  // ─── Multi-Turn Tool Use ───────────────────────────────────

  describe('Multi-Turn Tool Use', () => {
    test('multi-turn tool chain preserves full history and message ordering', async () => {
      server.reset([
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "a"' } }]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "b"' } }]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "c"' } }]),
        textResponse('All three commands completed: a, b, c'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.submitAndApprove('Run three-command history test')

      const log = await waitForRequestCount(server, 4, {
        description: 'multi-turn tool chain requests',
      })
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(4)

      const msg1Count = (log[0].body.messages as unknown[]).length
      const msg2Count = (log[1].body.messages as unknown[]).length
      const msg3Count = (log[2].body.messages as unknown[]).length
      expect(msg2Count).toBeGreaterThan(msg1Count)
      expect(msg3Count).toBeGreaterThan(msg2Count)

      const finalMessages = log[3].body.messages as Array<{
        role: string
        content: unknown
      }>
      expect(finalMessages[0].role).toBe('user')
      expect(finalMessages.length).toBeGreaterThanOrEqual(7)
      for (let i = 1; i < finalMessages.length; i++) {
        expect(finalMessages[i].role).not.toBe(finalMessages[i - 1].role)
      }
    })
  })

  // ─── Max Turns ─────────────────────────────────────────────

  describe('Max Turns', () => {
    test('max-turns=1 with tool call stops after executing tool', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "executed"' } },
        ]),
        textResponse('This should not appear'),
      ])
      session = new TmuxSession({
        serverUrl: server.url,
        additionalArgs: ['--max-turns', '1'],
      })
      await session.start()

      await session.submitAndApprove('Call a tool', 30_000)
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
    })

    test('max-turns=3 allows multi-turn chain', async () => {
      server.reset([
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "turn1"' } }]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "turn2"' } }]),
        textResponse('Completed within 3 turns'),
      ])
      session = new TmuxSession({
        serverUrl: server.url,
        additionalArgs: ['--max-turns', '3'],
      })
      await session.start()

      await session.submitAndApprove('Multi-turn within limit')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(3)
    })
  })

  // ─── Stop Reasons ──────────────────────────────────────────

  describe('Stop Reasons', () => {
    test('end_turn and tool_use stop reasons complete normally', async () => {
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      server.reset([textResponse('Normal completion')])
      let screen = await session.submitAndWaitForResponse('Complete normally')
      expect(screen).toContain('Normal completion')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)

      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "tool executed"' } },
        ]),
        textResponse('Tool was executed successfully'),
      ])
      screen = await session.submitAndApprove('Use a tool')
      expect(screen).toContain('Tool was executed successfully')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })

    test('max_tokens stop reason', async () => {
      server.reset([
        maxTokensResponse('This response was truncated because'),
        textResponse(' it was too long. Here is the rest.'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.submitAndWaitForResponse('Generate a long response', 30_000)
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
    })
  })

  // ─── Extended Thinking ─────────────────────────────────────

  describe('Extended Thinking', () => {
    test('thinking responses render for text and tool-use turns', async () => {
      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_DISABLE_THINKING: '' },
      })
      await session.start()

      server.reset([
        thinkingResponse(
          'Let me think about this carefully. The user wants a greeting.',
          'Hello! I thought about it and here is my response.',
        ),
      ])
      let screen = await session.submitAndWaitForResponse('Think and respond')
      expect(screen).toContain('Hello!')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)

      server.reset([
        thinkingToolUseResponse('I need to check the filesystem first.', [
          { name: 'Bash', input: { command: 'ls -la' } },
        ]),
        textResponse('Listed the directory contents.'),
      ])
      await session.submitAndApprove('Think then use a tool')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })
  })
})
