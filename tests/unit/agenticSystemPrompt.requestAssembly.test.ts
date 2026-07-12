import { afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import type { QuerySource } from '../../src/constants/querySource.js'
import { queryModelWithStreaming } from '../../src/services/api/claude.js'
import {
  AGENTIC_SYSTEM_PROMPT_INVARIANTS,
  withAgenticSystemPromptInvariants,
} from '../../src/utils/agenticSystemPrompt.js'
import { enableConfigs } from '../../src/utils/config.js'
import { createUserMessage } from '../../src/utils/messages.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../src/utils/systemPromptType.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

const originalFetch = globalThis.fetch
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalNodeEnv = process.env.NODE_ENV
let requestSequence = 0

function setupProvider(): void {
  resetProviderRegistry()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.NODE_ENV = 'development'
  const providers: Record<string, ProviderConfig> = {
    test: {
      type: 'openai-responses',
      baseUrl: 'http://provider.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'gpt-test' }],
    },
  }
  initProviderRegistry(providers)
  enableConfigs()
}

function completedResponse(): Response {
  const body = [
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"type":"message"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"type":"message"}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
    '',
  ].join('\n')

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings)
  }
  return []
}

function countInvariant(text: string): number {
  return text.split(AGENTIC_SYSTEM_PROMPT_INVARIANTS).length - 1
}

async function captureRequest(
  systemPrompt: SystemPrompt,
  querySource: QuerySource,
): Promise<string> {
  let requestBody: unknown
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected a JSON request body')
    }
    requestBody = JSON.parse(init.body)
    return completedResponse()
  }) as typeof globalThis.fetch

  for await (const message of queryModelWithStreaming({
    messages: [
      createUserMessage({
        content: `hello-${querySource}-${requestSequence++}`,
      }),
    ],
    systemPrompt,
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: 'gpt-test',
      isNonInteractiveSession: true,
      querySource,
      agents: [],
      allowedAgentTypes: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
    },
  })) {
    void message
  }

  expect(requestBody).toBeDefined()
  return collectStrings(requestBody).join('\n')
}

afterEach(() => {
  globalThis.fetch = originalFetch
  resetProviderRegistry()
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = originalNodeEnv
  }
})

describe('agentic system prompt request assembly', () => {
  test('agentic custom prompts receive exactly one invariant after replacement', async () => {
    setupProvider()
    const rendered = await captureRequest(
      asSystemPrompt(['CUSTOM REPLACEMENT PROMPT']),
      'sdk',
    )

    expect(rendered).toContain('CUSTOM REPLACEMENT PROMPT')
    expect(rendered).not.toContain('# Doing tasks')
    expect(countInvariant(rendered)).toBe(1)
  })

  test('clean direct auxiliary requests do not receive the invariant', async () => {
    setupProvider()

    for (const source of [
      'compact',
      'side_question',
      'generate_session_title',
    ] satisfies QuerySource[]) {
      const rendered = await captureRequest(
        asSystemPrompt(['AUXILIARY PROMPT']),
        source,
      )
      expect(countInvariant(rendered)).toBe(0)
    }
  })

  test('cache-sharing compact and side-question prompts preserve one invariant', async () => {
    setupProvider()
    const parentPrompt = withAgenticSystemPromptInvariants(
      asSystemPrompt(['PARENT PROMPT']),
    )

    for (const source of ['compact', 'side_question'] satisfies QuerySource[]) {
      const rendered = await captureRequest(parentPrompt, source)
      expect(rendered).toContain('PARENT PROMPT')
      expect(countInvariant(rendered)).toBe(1)
    }
  })
})
