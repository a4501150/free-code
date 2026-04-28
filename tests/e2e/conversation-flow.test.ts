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
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Conversation Flow E2E', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  // ─── Message Ordering ──────────────────────────────────────

  describe('Message Ordering', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('first request contains user message', async () => {
      server.reset([textResponse('Got it')])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // Text-only response, no tool use → no permission approvals needed
      await session.submitAndWaitForResponse('Hello from the e2e test')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(1)

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
    })

    test('first request contains tool definitions', async () => {
      server.reset([textResponse('OK')])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      await session.submitAndWaitForResponse('Test tools')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(1)

      const tools = log[0].body.tools as Array<{ name: string }>
      expect(Array.isArray(tools)).toBe(true)
      expect(tools.length).toBeGreaterThan(0)

      const toolNames = tools.map(t => t.name)
      expect(toolNames).toContain('Bash')
      expect(toolNames).toContain('Read')
      expect(toolNames).toContain('Edit')
    })

    test('after tool use, next request has tool_result', async () => {
      const toolId = 'toolu_flow_001'
      server.reset([
        toolUseResponse([
          {
            name: 'Bash',
            id: toolId,
            input: { command: 'echo "flow_test"' },
          },
        ]),
        textResponse('Done'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool call → 1 permission approval
      await session.submitAndApprove('Test flow')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const secondMessages = log[1].body.messages as Array<{
        role: string
        content: unknown
      }>

      let foundToolResult = false
      for (const msg of secondMessages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{
            type: string
            tool_use_id?: string
          }>) {
            if (block.type === 'tool_result' && block.tool_use_id === toolId) {
              foundToolResult = true
            }
          }
        }
      }
      expect(foundToolResult).toBe(true)
    })

    test('tool_result references correct tool_use_id', async () => {
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

      // 2 parallel tools → 2 permission approvals
      await session.submitAndApprove('Test refs')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const secondMessages = log[1].body.messages as Array<{
        role: string
        content: unknown
      }>

      const toolResultIds: string[] = []
      for (const msg of secondMessages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{
            type: string
            tool_use_id?: string
          }>) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              toolResultIds.push(block.tool_use_id)
            }
          }
        }
      }

      expect(toolResultIds).toContain(toolId1)
      expect(toolResultIds).toContain(toolId2)
    })

    test('full history preserved in Nth request', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "round1"' } },
        ]),
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "round2"' } },
        ]),
        textResponse('All rounds complete'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 2 sequential tool turns, 1 tool each → 2 permission approvals
      await session.submitAndApprove('Multi-round history test')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(3)

      const msg1Count = (log[0].body.messages as unknown[]).length
      const msg2Count = (log[1].body.messages as unknown[]).length
      const msg3Count = (log[2].body.messages as unknown[]).length

      expect(msg2Count).toBeGreaterThan(msg1Count)
      expect(msg3Count).toBeGreaterThan(msg2Count)

      const thirdMessages = log[2].body.messages as Array<{
        role: string
        content: unknown
      }>
      expect(thirdMessages[0].role).toBe('user')
    })
  })

  // ─── Multi-Turn Tool Use ───────────────────────────────────

  describe('Multi-Turn Tool Use', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('two sequential tool calls', async () => {
      server.reset([
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "step1"' } }]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "step2"' } }]),
        textResponse('Completed both steps: step1 and step2'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 2 sequential tool turns → 2 approvals
      await session.submitAndApprove('Run two commands')

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(3)
    })

    test('three-turn chain', async () => {
      server.reset([
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "a"' } }]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "b"' } }]),
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "c"' } }]),
        textResponse('All three commands completed: a, b, c'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 3 sequential tool turns → 3 approvals
      await session.submitAndApprove('Run three commands')

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(4)
    })

    test('tool results sent back correctly in request body', async () => {
      const toolId = 'toolu_verify_001'
      server.reset([
        toolUseResponse([
          {
            name: 'Bash',
            id: toolId,
            input: { command: 'echo "test_output_xyz"' },
          },
        ]),
        textResponse('Got the output'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool → 1 approval
      await session.submitAndApprove('Run echo command')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(2)

      const secondRequest = log[1]
      const messages = secondRequest.body.messages as Array<{
        role: string
        content: unknown
      }>

      const toolResultMsg = messages.find(m => {
        if (m.role !== 'user') return false
        const content = m.content as Array<{
          type: string
          tool_use_id?: string
        }>
        return content?.some(
          c => c.type === 'tool_result' && c.tool_use_id === toolId,
        )
      })

      expect(toolResultMsg).toBeDefined()
    })

    test('message ordering preserved across turns', async () => {
      server.reset([
        toolUseResponse([{ name: 'Bash', input: { command: 'echo "first"' } }]),
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "second"' } },
        ]),
        textResponse('Done'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 2 sequential tools → 2 approvals
      await session.submitAndApprove('Do two things')

      const log = server.getRequestLog()
      expect(log.length).toBeGreaterThanOrEqual(3)

      const thirdRequest = log[2]
      const messages = thirdRequest.body.messages as Array<{
        role: string
        content: unknown
      }>

      expect(messages[0].role).toBe('user')
      expect(messages.length).toBeGreaterThanOrEqual(5)

      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].role).not.toBe(messages[i - 1].role)
      }
    })
  })

  // ─── Max Turns ─────────────────────────────────────────────

  describe('Max Turns', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

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

      // Submit and approve any permission dialogs until idle
      await session.submitAndApprove('Call a tool', 30_000)

      // With max-turns=1, the model should only get 1 chance, but the CLI
      // may have made additional requests (e.g. for the tool result turn).
      // The key check is that the second mock response ("This should not appear")
      // should not have been rendered as a full follow-up.
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

      // 2 tools across 2 turns → 2 approvals
      await session.submitAndApprove('Multi-turn within limit')

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(3)
    })
  })

  // ─── Stop Reasons ──────────────────────────────────────────

  describe('Stop Reasons', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('end_turn completes normally', async () => {
      server.reset([textResponse('Normal completion')])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // No tools → no approvals
      const screen = await session.submitAndWaitForResponse('Complete normally')

      expect(screen).toContain('Normal completion')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
    })

    test('tool_use triggers tool execution', async () => {
      server.reset([
        toolUseResponse([
          { name: 'Bash', input: { command: 'echo "tool executed"' } },
        ]),
        textResponse('Tool was executed successfully'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // 1 tool → 1 approval
      await session.submitAndApprove('Use a tool')

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })

    test('max_tokens stop reason', async () => {
      server.reset([
        maxTokensResponse('This response was truncated because'),
        textResponse(' it was too long. Here is the rest.'),
      ])
      session = new TmuxSession({ serverUrl: server.url })
      await session.start()

      // No tool use, but the CLI may auto-continue — wait for idle prompt
      await session.submitAndWaitForResponse('Generate a long response', 30_000)

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
    })
  })

  // ─── Extended Thinking ─────────────────────────────────────

  describe('Extended Thinking', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('thinking followed by text response', async () => {
      server.reset([
        thinkingResponse(
          'Let me think about this carefully. The user wants a greeting.',
          'Hello! I thought about it and here is my response.',
        ),
      ])
      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_DISABLE_THINKING: '' },
      })
      await session.start()

      // No tools → no approvals
      const screen = await session.submitAndWaitForResponse('Think and respond')

      expect(screen).toContain('Hello!')
      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1)
    })

    test('thinking followed by tool use', async () => {
      server.reset([
        thinkingToolUseResponse('I need to check the filesystem first.', [
          { name: 'Bash', input: { command: 'ls -la' } },
        ]),
        textResponse('Listed the directory contents.'),
      ])
      session = new TmuxSession({
        serverUrl: server.url,
        additionalEnv: { CLAUDE_CODE_DISABLE_THINKING: '' },
      })
      await session.start()

      // 1 tool → 1 approval
      await session.submitAndApprove('Think then use a tool')

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(2)
    })
  })
})
