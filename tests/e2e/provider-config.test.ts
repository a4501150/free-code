/**
 * Provider Config E2E Tests
 *
 * Tests the provider-based model system: configuring providers in modelSettings.json,
 * routing requests through OpenAI Chat Completions adapter, model alias resolution,
 * and per-provider caching behavior.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(120_000)

// e2e tests launch the compiled CLI in tmux and drive it end-to-end —
// they need far more than bun's 5s default. Matches plan-mode.test.ts.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { MockOpenAIServer } from '../helpers/mock-openai-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)

describe('Provider Config E2E', () => {
  let anthropicServer: MockAnthropicServer
  let openaiServer: MockOpenAIServer

  beforeAll(async () => {
    anthropicServer = new MockAnthropicServer()
    await anthropicServer.start()
    openaiServer = new MockOpenAIServer()
    await openaiServer.start()
  })

  afterAll(() => {
    anthropicServer.stop()
    openaiServer.stop()
  })

  // ─── OpenAI Chat Completions Provider ─────────────────────

  describe('OpenAI Chat Completions Provider', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('routes, translates, authenticates, and handles tool use', async () => {
      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: {
                active: 'apiKey',
                apiKey: { key: 'my-secret-key-123' },
              },
              models: [{ id: 'test-model', label: 'Test Model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      openaiServer.reset([{ kind: 'text', text: 'Hello from OpenAI!' }])
      anthropicServer.reset([textResponse('fallback')])
      await session.sendLine('Say hello')
      const screen = await session.waitForText('Hello from OpenAI', 15_000)
      expect(screen).toContain('Hello from OpenAI')
      await session.waitForPrompt(15_000)

      let openaiRequests = openaiServer.getRequestLog()
      expect(openaiRequests.length).toBeGreaterThanOrEqual(1)
      expect(openaiRequests[0]!.body.model).toBe('test-model')
      expect(openaiRequests[0]!.body.messages).toBeDefined()
      expect(openaiRequests[0]!.body.stream).toBe(true)
      expect(openaiRequests[0]!.headers['authorization']).toBe(
        'Bearer my-secret-key-123',
      )

      const messages = openaiRequests[0]!.body.messages as Array<{
        role: string
        content: unknown
      }>
      expect(messages.find(m => m.role === 'system')).toBeDefined()
      expect(messages.find(m => m.role === 'user')).toBeDefined()

      openaiServer.reset([
        {
          kind: 'tool_call',
          toolCalls: [
            {
              id: 'call_test_001',
              name: 'Bash',
              arguments: JSON.stringify({
                command: 'echo "tool test ok"',
                description: 'Test tool',
              }),
            },
          ],
        },
        { kind: 'text', text: 'Tool executed successfully!' },
      ])
      anthropicServer.reset([textResponse('fallback')])
      await session.submitAndApprove('Run a test command')
      const toolScreen = await session.waitForText(
        'Tool executed successfully',
        20_000,
      )
      expect(toolScreen).toContain('Tool executed successfully')

      openaiRequests = openaiServer.getRequestLog()
      const firstReq = openaiRequests[0]!
      expect(firstReq.body.tools).toBeDefined()
      const tools = firstReq.body.tools as Array<{
        type: string
        function: { name: string }
      }>
      expect(tools[0]!.type).toBe('function')
      expect(tools[0]!.function).toBeDefined()

      const secondReq = openaiRequests[1]!
      const msgs = secondReq.body.messages as Array<{
        role: string
        tool_call_id?: string
      }>
      const toolMsg = msgs.find(m => m.role === 'tool')
      expect(toolMsg).toBeDefined()
      expect(toolMsg!.tool_call_id).toBe('call_test_001')
    })
  })

  // ─── Provider-Qualified Model Syntax ────────────────────────

  describe('Provider-Qualified Model Syntax', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('qualified OpenAI model routes to correct provider and model ID', async () => {
      // Both providers share the same model ID "shared-model".
      // Using "test-openai:shared-model" should route to the OpenAI server.
      openaiServer.reset([{ kind: 'text', text: 'From OpenAI provider' }])
      anthropicServer.reset([textResponse('From Anthropic provider')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'shared-model' }],
            },
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'shared-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-openai:shared-model'],
      })
      await session.start()

      await session.sendLine('Hello')
      const screen = await session.waitForText('From OpenAI provider', 15_000)
      expect(screen).toContain('From OpenAI provider')

      // Verify request went to OpenAI server
      const openaiRequests = openaiServer.getRequestLog()
      expect(openaiRequests.length).toBeGreaterThanOrEqual(1)
      expect(openaiRequests[0]!.body.model).toBe('shared-model')
    })

    test('qualified name routes to correct provider (anthropic)', async () => {
      // Same setup, but "test-anthropic:shared-model" should route to Anthropic.
      openaiServer.reset([{ kind: 'text', text: 'From OpenAI provider' }])
      anthropicServer.reset([textResponse('From Anthropic provider')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'shared-model' }],
            },
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'shared-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-anthropic:shared-model'],
      })
      await session.start()

      await session.sendLine('Hello')
      const screen = await session.waitForText(
        'From Anthropic provider',
        15_000,
      )
      expect(screen).toContain('From Anthropic provider')

      // Verify request went to Anthropic server, not OpenAI
      const anthropicRequests = anthropicServer.getRequestLog()
      expect(anthropicRequests.length).toBeGreaterThanOrEqual(1)
      expect(openaiServer.getRequestLog().length).toBe(0)
    })
  })

  // ─── Per-Provider Caching ──────────────────────────────────

  describe('Per-Provider Caching', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('automatic-prefix provider has no cache_control in requests', async () => {
      openaiServer.reset([{ kind: 'text', text: 'No cache markers' }])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              cache: { type: 'automatic-prefix' },
              auth: {
                active: 'apiKey',
                apiKey: { key: 'test-key' },
              },
              models: [{ id: 'test-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-model'],
      })
      await session.start()

      await session.sendLine('Test caching')
      await session.waitForText('No cache markers', 15_000)

      // The Chat Completions format doesn't have cache_control,
      // so the adapter naturally strips it. Verify the request body
      // doesn't contain any cache_control references.
      const requests = openaiServer.getRequestLog()
      expect(requests.length).toBeGreaterThanOrEqual(1)
      const bodyStr = JSON.stringify(requests[0]!.body)
      expect(bodyStr).not.toContain('cache_control')
    })

    test('explicit-breakpoint provider marks tools, system and last message', async () => {
      // The cache prefix order is tools -> system -> messages, so these are
      // three distinct resume points. The tools breakpoint is the only one
      // ahead of the attribution block, whose cch= hash changes every request.
      anthropicServer.reset([textResponse('Cached')])

      session = new TmuxSession({ serverUrl: anthropicServer.url })
      await session.start()
      await session.sendLine('Test breakpoints')
      await session.waitForText('Cached', 15_000)

      const requests = anthropicServer.getRequestLog()
      expect(requests.length).toBeGreaterThanOrEqual(1)
      const body = requests[0]!.body as {
        system: Array<{ text: string; cache_control?: unknown }>
        tools: Array<{ name: string; cache_control?: unknown }>
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }

      // Exactly one marked tool, and it is the last one.
      const markedTools = body.tools.filter(t => t.cache_control !== undefined)
      expect(markedTools).toHaveLength(1)
      expect(body.tools.at(-1)!.cache_control).toBeDefined()

      // Exactly one marked system block, and never the attribution block.
      const markedSystem = body.system.filter(
        b => b.cache_control !== undefined,
      )
      expect(markedSystem).toHaveLength(1)
      expect(body.system[0]!.text).toContain('x-anthropic-billing-header')
      expect(body.system[0]!.cache_control).toBeUndefined()

      // Exactly one marked message, and it is the last.
      const markedMessages = body.messages.filter(m =>
        m.content.some(c => c.cache_control !== undefined),
      )
      expect(markedMessages).toHaveLength(1)
      expect(
        body.messages.at(-1)!.content.some(c => c.cache_control !== undefined),
      ).toBe(true)

      // 3 of the API's 4 allowed breakpoints; a 5th would be a 400.
      const total = JSON.stringify(body).split('"cache_control"').length - 1
      expect(total).toBe(3)

      // Global cache scope is gone.
      expect(JSON.stringify(body)).not.toContain('"scope"')
    })

    test('the system prompt carries no session-scoped bytes', async () => {
      // What lets a fresh session in a new project read the system prefix
      // instead of writing it. Environment facts live in the user context.
      anthropicServer.reset([textResponse('Static')])

      session = new TmuxSession({ serverUrl: anthropicServer.url })
      await session.start()
      await session.sendLine('Test static prompt')
      await session.waitForText('Static', 15_000)

      const body = anthropicServer.getRequestLog()[0]!.body as {
        system: Array<{ text: string }>
        messages: Array<{ content: Array<{ text?: string }> }>
      }
      const systemText = body.system.map(b => b.text).join('\n')
      expect(systemText).not.toContain(session.cwd)
      expect(systemText).not.toContain('# Environment')
      expect(systemText).not.toContain('# Scratchpad Directory')

      // ...and they are present in the prepended user-context message instead.
      const firstMessage = body.messages[0]!.content.map(
        c => c.text ?? '',
      ).join('\n')
      expect(firstMessage).toContain('# env')
      expect(firstMessage).toContain('Primary working directory')
    })

    test('two sessions in different projects send an identical system prefix', async () => {
      // The payoff for keeping the system prompt static: a fresh session in a
      // different directory can *read* the cached system prefix instead of
      // writing it. Previously guaranteed to be a write, because cwd and the
      // per-session scratchpad path were both in the system prompt.
      async function cachedSystemBlock(): Promise<string> {
        anthropicServer.reset([textResponse('Done.')])
        // No cwd option, so each session gets its own mkdtemp directory.
        const s = new TmuxSession({ serverUrl: anthropicServer.url })
        try {
          await s.start()
          await s.sendLine('hello')
          await s.waitForText('Done.', 15_000)
          const body = anthropicServer.getRequestLog()[0]!.body as {
            system: Array<{ text: string; cache_control?: unknown }>
          }
          const cached = body.system.filter(b => b.cache_control !== undefined)
          expect(cached).toHaveLength(1)
          return cached[0]!.text
        } finally {
          await s.stop()
        }
      }

      const first = await cachedSystemBlock()
      const second = await cachedSystemBlock()

      // Byte-for-byte, with no normalization: any per-session or per-project
      // value that creeps back into a prompt section will fail here.
      expect(second).toBe(first)
      // Guard against the assertion passing on an empty or trivial block.
      expect(first.length).toBeGreaterThan(2000)
    })
  })

  // ─── Default Model Config ────────────────────────────────────

  describe('Default Model Config', () => {
    let session: TmuxSession

    afterEach(async () => {
      if (session) await session.stop()
    })

    test('defaultModel in settings routes to correct provider', async () => {
      // Use settings.defaultModel (provider-qualified) to select a model
      // without --model flag. Should route to the OpenAI server.
      openaiServer.reset([{ kind: 'text', text: 'From default model config' }])
      anthropicServer.reset([textResponse('fallback')])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          defaultModel: 'test-openai:test-model',
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'shared-model' }],
            },
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'test-model' }],
            },
          },
        },
      })
      await session.start()

      await session.sendLine('Hello')
      const screen = await session.waitForText(
        'From default model config',
        15_000,
      )
      expect(screen).toContain('From default model config')

      // Verify the request went to the OpenAI server
      const openaiRequests = openaiServer.getRequestLog()
      expect(openaiRequests.length).toBeGreaterThanOrEqual(1)
      expect(openaiRequests[0]!.body.model).toBe('test-model')
    })

    test('defaultModel routes to the correct provider', async () => {
      openaiServer.reset([{ kind: 'text', text: 'From defaultModel' }])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          defaultModel: 'test-openai:test-model',
          providers: {
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'test-model' }],
            },
          },
        },
      })
      await session.start()

      await session.sendLine('Hello')
      const screen = await session.waitForText('From defaultModel', 15_000)
      expect(screen).toContain('From defaultModel')

      const openaiRequests = openaiServer.getRequestLog()
      expect(openaiRequests.length).toBeGreaterThanOrEqual(1)
    })

    test('--model flag overrides defaultModel', async () => {
      // --model flag should override defaultModel from settings
      anthropicServer.reset([textResponse('From --model flag')])
      openaiServer.reset([{ kind: 'text', text: 'From defaultModel' }])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        settings: {
          defaultModel: 'test-openai:test-model', // should be overridden
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'flag-model' }],
            },
            'test-openai': {
              type: 'openai-chat-completions',
              baseUrl: `${openaiServer.url}/v1`,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'test-model' }],
            },
          },
        },
        additionalArgs: ['--model', 'test-anthropic:flag-model'],
      })
      await session.start()

      await session.sendLine('Hello')
      const screen = await session.waitForText('From --model flag', 15_000)
      expect(screen).toContain('From --model flag')

      // Verify request went to Anthropic (--model flag), not OpenAI (defaultModel)
      const anthropicRequests = anthropicServer.getRequestLog()
      expect(anthropicRequests.length).toBeGreaterThanOrEqual(1)
      expect(openaiServer.getRequestLog().length).toBe(0)
    })
  })

  // ─── Subagent Model Tier Routing ───────────────────────────
  //
  // Exercises the mostPowerful tier sentinel in src/utils/model/agent.ts:
  //   1. Subagent with model: mostPowerful uses defaultMostPowerfulModel when
  //      configured.
  //   2. defaultSubagentModel is a blunt override that beats the tier sentinel
  //      (clause a — documented in CLAUDE.md).
  //   3. Falls back to inherit (main model) when defaultMostPowerfulModel is
  //      unset.
  //
  // Uses a user-defined markdown agent rather than the built-in Plan agent:
  // Plan is gated behind `feature('BUILTIN_EXPLORE_PLAN_AGENTS')` which is
  // dev-full only, so the stock ./cli build (used by e2e tests) doesn't
  // include it. The markdown path exercises the identical resolution code
  // in getAgentModel().

  describe('Subagent Model Tier Routing', () => {
    let session: TmuxSession
    let tierCwd: string | null = null

    // Unique marker in the user-agent's system prompt — used to pick the
    // subagent's request out of the mock-server log.
    const AGENT_MARKER = 'TIER_TEST_SUBAGENT_MARKER_XYZ123'

    async function setupTierAgentCwd(): Promise<string> {
      const cwd = await mkdtemp(join(tmpdir(), 'claude-e2e-tier-cwd-'))
      const agentsDir = join(cwd, '.claude', 'agents')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(
        join(agentsDir, 'TierTest.md'),
        [
          '---',
          'name: TierTest',
          'description: Test subagent for mostPowerful tier routing',
          'model: mostPowerful',
          '---',
          '',
          `You are a test subagent. ${AGENT_MARKER}. Respond briefly.`,
          '',
        ].join('\n'),
      )
      return cwd
    }

    afterEach(async () => {
      if (session) await session.stop()
      if (tierCwd) {
        await rm(tierCwd, { recursive: true, force: true }).catch(() => {})
        tierCwd = null
      }
    })

    /**
     * Return the model field of the request whose system prompt carries the
     * unique TierTest marker. Returns undefined if no such request exists.
     */
    function tierSubagentModel(
      requests: ReturnType<MockAnthropicServer['getRequestLog']>,
    ): string | undefined {
      const subReq = requests.find(r => systemMatchesMarker(r.body.system))
      return subReq?.body.model
    }

    function systemMatchesMarker(system: unknown): boolean {
      if (typeof system === 'string') return system.includes(AGENT_MARKER)
      if (Array.isArray(system)) {
        for (const block of system) {
          if (
            block &&
            typeof block === 'object' &&
            'text' in block &&
            typeof (block as { text: unknown }).text === 'string' &&
            (block as { text: string }).text.includes(AGENT_MARKER)
          ) {
            return true
          }
        }
      }
      return false
    }

    /**
     * Assert the subagent request's model matches `expected`. On mismatch,
     * throw with a detailed dump of every request in the log (model + whether
     * it carried the tier marker) so we can diagnose the code path that set
     * the unexpected value without needing to reproduce the flake.
     */
    function assertTierSubagentModel(
      requests: ReturnType<MockAnthropicServer['getRequestLog']>,
      expected: string,
    ): void {
      const actual = tierSubagentModel(requests)
      if (actual === expected) return
      const summary = requests
        .map((r, i) => {
          const marker = systemMatchesMarker(r.body.system) ? ' [MARKER]' : ''
          return `  [${i}] model=${JSON.stringify(r.body.model)}${marker}`
        })
        .join('\n')
      throw new Error(
        `tier subagent model mismatch — expected ${JSON.stringify(expected)}, ` +
          `got ${JSON.stringify(actual)}\n` +
          `request log (${requests.length} requests):\n${summary}`,
      )
    }

    test('subagent with model:mostPowerful uses defaultMostPowerfulModel when configured', async () => {
      tierCwd = await setupTierAgentCwd()

      // Main agent spawns TierTest subagent; subagent returns a short reply;
      // main agent wraps up. Verify the subagent request hits powerful-model.
      anthropicServer.reset([
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'Tier test',
              prompt: 'Run the tier test',
              subagent_type: 'TierTest',
            },
          },
        ]),
        textResponse('Tier done'),
        textResponse('Main done'),
      ])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        cwd: tierCwd,
        settings: {
          defaultModel: 'test-anthropic:main-model',
          defaultMostPowerfulModel: 'test-anthropic:powerful-model',
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'main-model' }, { id: 'powerful-model' }],
            },
          },
        },
        // TmuxSession's env -i isolation already prevents host settings pollution.
      })
      await session.start()

      await session.submitAndApprove('Run tier test', 90_000)
      await session.waitForText('Main done', 30_000)

      const requests = anthropicServer.getRequestLog()
      assertTierSubagentModel(requests, 'powerful-model')

      // Sanity: at least one main-loop request used main-model.
      expect(requests.some(r => r.body.model === 'main-model')).toBe(true)
    })

    test('defaultSubagentModel overrides mostPowerful sentinel (clause a)', async () => {
      tierCwd = await setupTierAgentCwd()

      // With defaultSubagentModel set, the tier sentinel is short-circuited —
      // sub-model wins regardless of defaultMostPowerfulModel.
      anthropicServer.reset([
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'Tier test',
              prompt: 'Run the tier test',
              subagent_type: 'TierTest',
            },
          },
        ]),
        textResponse('Tier done'),
        textResponse('Main done'),
      ])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        cwd: tierCwd,
        settings: {
          defaultModel: 'test-anthropic:main-model',
          defaultMostPowerfulModel: 'test-anthropic:powerful-model',
          defaultSubagentModel: 'test-anthropic:sub-model',
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [
                { id: 'main-model' },
                { id: 'powerful-model' },
                { id: 'sub-model' },
              ],
            },
          },
        },
      })
      await session.start()

      await session.submitAndApprove('Run tier test', 90_000)
      await session.waitForText('Main done', 30_000)

      const requests = anthropicServer.getRequestLog()
      assertTierSubagentModel(requests, 'sub-model')
    })

    test('mostPowerful falls back to inherit when defaultMostPowerfulModel is unset', async () => {
      tierCwd = await setupTierAgentCwd()

      // With only defaultModel configured, the mostPowerful sentinel falls
      // back to inherit — the subagent uses the parent's main-model.
      anthropicServer.reset([
        toolUseResponse([
          {
            name: 'Agent',
            input: {
              description: 'Tier test',
              prompt: 'Run the tier test',
              subagent_type: 'TierTest',
            },
          },
        ]),
        textResponse('Tier done'),
        textResponse('Main done'),
      ])

      session = new TmuxSession({
        serverUrl: anthropicServer.url,
        cwd: tierCwd,
        settings: {
          defaultModel: 'test-anthropic:main-model',
          // no defaultMostPowerfulModel, no defaultSubagentModel
          providers: {
            'test-anthropic': {
              type: 'anthropic',
              baseUrl: anthropicServer.url,
              auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
              models: [{ id: 'main-model' }],
            },
          },
        },
      })
      await session.start()

      await session.submitAndApprove('Run tier test', 90_000)
      await session.waitForText('Main done', 30_000)

      const requests = anthropicServer.getRequestLog()
      assertTierSubagentModel(requests, 'main-model')
    })
  })
})
