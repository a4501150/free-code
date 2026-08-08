import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getCLISyspromptPrefix } from '../../src/constants/system.js'
import {
  addCacheBreakpoints,
  buildSystemPromptBlocks,
} from '../../src/services/api/claude.js'
import { splitSysPromptPrefix } from '../../src/services/api/systemPromptBlocks.js'
import { getCacheControl } from '../../src/utils/cacheControl.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import { asSystemPrompt } from '../../src/utils/systemPromptType.js'
import type { AssistantMessage, UserMessage } from '../../src/types/message.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

function initAnthropicRegistry(): void {
  const providers: Record<string, ProviderConfig> = {
    anthropic: {
      type: 'anthropic',
      baseUrl: 'http://anthropic.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'claude-test' }],
    },
  }
  initProviderRegistry(providers)
}

beforeEach(() => {
  resetProviderRegistry()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  initAnthropicRegistry()
})

afterEach(() => {
  resetProviderRegistry()
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

const ATTRIBUTION =
  'x-anthropic-billing-header: cc_version=1.0.0.abc; cc_entrypoint=cli; cch=00000;'

function userMsg(content: UserMessage['message']['content']): UserMessage {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  } as UserMessage
}

function assistantMsg(
  content: AssistantMessage['message']['content'],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content },
  } as unknown as AssistantMessage
}

describe('splitSysPromptPrefix', () => {
  test('never emits a cache breakpoint on the attribution block', () => {
    // The attribution block's cch= field is a hash of the whole request body,
    // so it differs on every request. A breakpoint on it could never hit.
    const blocks = splitSysPromptPrefix(
      asSystemPrompt([ATTRIBUTION, getCLISyspromptPrefix(), 'body']),
    )
    expect(blocks[0]?.text).toBe(ATTRIBUTION)
    expect(blocks[0]?.cached).toBe(false)
  })

  test('emits exactly one cached block, and it is last', () => {
    const blocks = splitSysPromptPrefix(
      asSystemPrompt([ATTRIBUTION, getCLISyspromptPrefix(), 'a', 'b']),
    )
    const cached = blocks.filter(b => b.cached)
    expect(cached).toHaveLength(1)
    expect(blocks.at(-1)?.cached).toBe(true)
    // Remaining sections are joined into that one block.
    expect(blocks.at(-1)?.text).toBe('a\n\nb')
  })

  test('identifies blocks by content, not position', () => {
    const blocks = splitSysPromptPrefix(
      asSystemPrompt(['body', ATTRIBUTION, getCLISyspromptPrefix()]),
    )
    expect(blocks.map(b => b.text)).toEqual([
      ATTRIBUTION,
      getCLISyspromptPrefix(),
      'body',
    ])
  })

  test('drops empty sections', () => {
    const blocks = splitSysPromptPrefix(
      asSystemPrompt([ATTRIBUTION, getCLISyspromptPrefix(), '']),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks.some(b => b.cached)).toBe(false)
  })

  test('does not leak a sentinel or placeholder into system text', () => {
    // Regression guard: the deleted SYSTEM_PROMPT_DYNAMIC_BOUNDARY was inserted
    // based on the default provider but filtered based on the selected model,
    // so on any mixed-provider setup the literal sentinel reached the model.
    const blocks = splitSysPromptPrefix(
      asSystemPrompt([ATTRIBUTION, getCLISyspromptPrefix(), 'real content']),
    )
    for (const block of blocks) {
      expect(block.text).not.toContain('__')
    }
  })
})

describe('buildSystemPromptBlocks', () => {
  const prompt = asSystemPrompt([ATTRIBUTION, getCLISyspromptPrefix(), 'body'])

  test('attaches cache_control only to the cached block', () => {
    const blocks = buildSystemPromptBlocks(prompt, true)
    expect(blocks.map(b => b.cache_control !== undefined)).toEqual([
      false,
      false,
      true,
    ])
  })

  test('emits no cache_control at all when caching is disabled', () => {
    const blocks = buildSystemPromptBlocks(prompt, false)
    expect(blocks.some(b => b.cache_control !== undefined)).toBe(false)
  })

  test('never emits a scope field', () => {
    // Global cache scope is gone; a stray scope would need the deleted beta.
    const blocks = buildSystemPromptBlocks(prompt, true)
    for (const block of blocks) {
      expect(block.cache_control).not.toHaveProperty('scope')
    }
  })

  test('stays within the API limit of 4 breakpoints', () => {
    // System accounts for 1; the tools array and the last message take 1 each.
    const blocks = buildSystemPromptBlocks(prompt, true)
    expect(blocks.filter(b => b.cache_control !== undefined)).toHaveLength(1)
  })
})

describe('addCacheBreakpoints', () => {
  test('marks the final message', () => {
    const result = addCacheBreakpoints(
      [userMsg('one'), assistantMsg([{ type: 'text', text: 'two' }])],
      true,
    )
    expect(result[0]?.content.at(-1)).not.toHaveProperty('cache_control')
    expect(result[1]?.content.at(-1)).toHaveProperty('cache_control')
  })

  test('marks exactly one message', () => {
    const result = addCacheBreakpoints(
      [userMsg('a'), userMsg('b'), userMsg('c')],
      true,
    )
    const marked = result.filter(m =>
      m.content.some(b => 'cache_control' in b && b.cache_control),
    )
    expect(marked).toHaveLength(1)
  })

  test('converts string content to a marked text block', () => {
    const result = addCacheBreakpoints([userMsg('hello')], true)
    expect(result[0]?.content).toHaveLength(1)
    expect(result[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'hello',
    })
    expect(result[0]?.content[0]).toHaveProperty('cache_control')
  })

  test('marks only the last block of an array', () => {
    const result = addCacheBreakpoints(
      [
        userMsg([
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ]),
      ],
      true,
    )
    expect(result[0]?.content[0]).not.toHaveProperty('cache_control')
    expect(result[0]?.content[1]).toHaveProperty('cache_control')
  })

  test('falls back past a trailing reasoning block instead of dropping the marker', () => {
    // Anthropic rejects cache_control on a thinking block. Only testing the
    // final block used to drop the breakpoint entirely for such a turn.
    const result = addCacheBreakpoints(
      [
        assistantMsg([
          { type: 'text', text: 'answer' },
          { type: 'reasoning', text: 'thinking' },
        ]),
      ],
      true,
    )
    const reasoning = result[0]?.content.find(b => b.type === 'reasoning')
    const text = result[0]?.content.find(b => b.type === 'text')
    expect(reasoning).not.toHaveProperty('cache_control')
    expect(text).toHaveProperty('cache_control')
  })

  test('marks the last eligible block when reasoning is interleaved', () => {
    const result = addCacheBreakpoints(
      [
        assistantMsg([
          { type: 'reasoning', text: 'first' },
          { type: 'text', text: 'answer' },
          { type: 'reasoning', text: 'second' },
        ]),
      ],
      true,
    )
    const marked = result[0]?.content.filter(b => 'cache_control' in b)
    expect(marked).toHaveLength(1)
    expect(marked?.[0]).toMatchObject({ type: 'text', text: 'answer' })
  })

  test('marks nothing when every block is reasoning', () => {
    const result = addCacheBreakpoints(
      [assistantMsg([{ type: 'reasoning', text: 'only thinking' }])],
      true,
    )
    expect(
      result[0]?.content.some(b => 'cache_control' in b && b.cache_control),
    ).toBe(false)
  })

  test('skipCacheWrite shifts the marker to the second-to-last message', () => {
    const result = addCacheBreakpoints(
      [userMsg('a'), userMsg('b'), userMsg('c')],
      true,
      undefined,
      true,
    )
    expect(result[1]?.content.at(-1)).toHaveProperty('cache_control')
    expect(result[2]?.content.at(-1)).not.toHaveProperty('cache_control')
  })

  test('skipCacheWrite marks nothing when there is only one message', () => {
    const result = addCacheBreakpoints([userMsg('only')], true, undefined, true)
    const marked = result.filter(m =>
      m.content.some(b => 'cache_control' in b && b.cache_control),
    )
    expect(marked).toHaveLength(0)
  })

  test('marks nothing when caching is disabled', () => {
    const result = addCacheBreakpoints([userMsg('a'), userMsg('b')], false)
    const marked = result.filter(m =>
      m.content.some(b => 'cache_control' in b && b.cache_control),
    )
    expect(marked).toHaveLength(0)
  })
})

describe('getCacheControl', () => {
  test('returns a bare ephemeral marker with no scope', () => {
    const result = getCacheControl()
    expect(result).toEqual({ type: 'ephemeral' })
    expect(result).not.toHaveProperty('scope')
  })

  test('omits ttl for a query source outside the allowlist', () => {
    expect(getCacheControl({ querySource: 'model_validation' })).toEqual({
      type: 'ephemeral',
    })
  })

  test('honours ENABLE_PROMPT_CACHING_1H_BEDROCK on bedrock', () => {
    resetProviderRegistry()
    const providers: Record<string, ProviderConfig> = {
      bedrock: {
        type: 'bedrock-converse',
        cache: { type: 'explicit-breakpoint' },
        auth: { active: 'aws', aws: { region: 'us-east-1' } },
        models: [{ id: 'anthropic.claude-sonnet-4-5-20250929-v1:0' }],
      },
    }
    initProviderRegistry(providers)
    const previous = process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK
    process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = '1'
    try {
      expect(getCacheControl({ querySource: 'sdk' })).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      })
    } finally {
      if (previous === undefined) {
        delete process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK
      } else {
        process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = previous
      }
    }
  })
})
