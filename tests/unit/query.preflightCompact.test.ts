import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../src/state/AppState.js'
import type { ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import { query, type QueryParams } from '../../src/query.js'
import type { QueryDeps } from '../../src/query/deps.js'
import {
  createAssistantAPIErrorMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../src/utils/messages.js'
import type { CompactionResult } from '../../src/services/compact/compact.js'

function compactionResult(summary = 'summary'): CompactionResult {
  return {
    boundaryMarker: createCompactBoundaryMessage('auto', 170_000),
    summaryMessages: [createUserMessage({ content: summary })],
    attachments: [],
    hookResults: [],
  }
}

function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    },
    fastMode: false,
    mcp: { tools: [], clients: [] },
    sessionHooks: new Map(),
  } as unknown as AppState

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'unknown-test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    agentId: 'agent-test' as never,
    messages,
  } as unknown as ToolUseContext
}

function createHarness({
  counts,
  compactResponses,
}: {
  counts: Array<number | null>
  compactResponses: Array<Awaited<ReturnType<QueryDeps['autocompact']>>>
}) {
  const initialMessages = [createUserMessage({ content: 'test prompt' })]
  const autocompactOptions: Array<{ tokenCount?: number } | undefined> = []
  let callModelCalls = 0
  let countPromptTokensCalls = 0

  const deps: QueryDeps = {
    async *callModel() {
      callModelCalls++
      yield createAssistantAPIErrorMessage({
        content: 'terminal test response',
        error: 'unknown',
      })
    },
    async microcompact(messages) {
      return { messages }
    },
    async autocompact(_messages, _context, _params, _source, _tracking, options) {
      autocompactOptions.push(options)
      return compactResponses.shift() ?? { wasCompacted: false }
    },
    async countPromptTokens() {
      countPromptTokensCalls++
      return counts.shift() ?? null
    },
    uuid: () => `uuid-${autocompactOptions.length}`,
  }

  const params: QueryParams = {
    messages: initialMessages,
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    toolUseContext: createToolUseContext(initialMessages),
    querySource: 'agent:custom',
    deps,
  }

  return {
    params,
    autocompactOptions,
    get callModelCalls() {
      return callModelCalls
    },
    get countPromptTokensCalls() {
      return countPromptTokensCalls
    },
  }
}

async function collectQuery(params: QueryParams) {
  const messages = []
  const generator = query(params)
  let next = await generator.next()
  while (!next.done) {
    messages.push(next.value)
    next = await generator.next()
  }
  return { messages, terminal: next.value }
}

describe('query exact preflight compaction', () => {
  test('fresh request forwards exact count into auto-compact', async () => {
    const harness = createHarness({
      counts: [170_000, 100],
      compactResponses: [
        { wasCompacted: true, compactionResult: compactionResult() },
      ],
    })

    await collectQuery(harness.params)

    expect(harness.autocompactOptions).toEqual([{ tokenCount: 170_000 }])
    expect(harness.countPromptTokensCalls).toBe(2)
    expect(harness.callModelCalls).toBe(1)
  })

  test('fresh request falls back to estimator when exact count is unavailable', async () => {
    const harness = createHarness({ counts: [null], compactResponses: [] })

    await collectQuery(harness.params)

    expect(harness.autocompactOptions).toEqual([undefined])
    expect(harness.callModelCalls).toBe(1)
  })

  test('first post-compact exact count triggers one proactive recompact', async () => {
    const harness = createHarness({
      counts: [100, 170_000, 100],
      compactResponses: [
        { wasCompacted: true, compactionResult: compactionResult('summary one') },
        { wasCompacted: true, compactionResult: compactionResult('summary two') },
      ],
    })

    await collectQuery(harness.params)

    expect(harness.autocompactOptions).toEqual([
      { tokenCount: 100 },
      { tokenCount: 170_000 },
    ])
    expect(harness.callModelCalls).toBe(1)
  })

  test('blocks dispatch when bounded post-compact recompact remains oversized', async () => {
    const harness = createHarness({
      counts: [100, 170_000, 170_000],
      compactResponses: [
        { wasCompacted: true, compactionResult: compactionResult('summary one') },
        { wasCompacted: true, compactionResult: compactionResult('summary two') },
      ],
    })

    const result = await collectQuery(harness.params)

    expect(result.terminal).toEqual({ reason: 'blocking_limit' })
    expect(harness.callModelCalls).toBe(0)
    expect(
      result.messages.some(
        message => message.type === 'assistant' && message.isApiErrorMessage,
      ),
    ).toBe(true)
  })
})
