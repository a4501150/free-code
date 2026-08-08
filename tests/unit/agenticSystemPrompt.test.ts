import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  isAgenticQuerySource,
  type QuerySource,
} from '../../src/constants/querySource.js'
import { getCLISyspromptPrefix } from '../../src/constants/system.js'
import { buildSystemPromptBlocks } from '../../src/services/api/claude.js'
import { splitSysPromptPrefix } from '../../src/services/api/systemPromptBlocks.js'
import {
  AGENTIC_SYSTEM_PROMPT_INVARIANTS,
  withAgenticSystemPromptInvariants,
  withAgenticSystemPromptInvariantsForQuery,
} from '../../src/utils/agenticSystemPrompt.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import { asSystemPrompt } from '../../src/utils/systemPromptType.js'

const originalDisableExperimentalBetas =
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

function countInvariant(text: string): number {
  return text.split(AGENTIC_SYSTEM_PROMPT_INVARIANTS).length - 1
}

beforeEach(() => {
  resetProviderRegistry()
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const providers: Record<string, ProviderConfig> = {
    anthropic: {
      type: 'anthropic',
      baseUrl: 'http://anthropic.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'claude-test' }],
    },
  }
  initProviderRegistry(providers)
})

afterEach(() => {
  resetProviderRegistry()
  if (originalDisableExperimentalBetas === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  } else {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS =
      originalDisableExperimentalBetas
  }
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

describe('agentic system prompt invariants', () => {
  test('classifies only agentic query sources', () => {
    const agentic: QuerySource[] = [
      'repl_main_thread',
      'repl_main_thread_background',
      'sdk',
      'agent:default',
      'agent:custom',
      'agent:builtin:general-purpose',
      'hook_agent',
      'verification_agent',
    ]
    const auxiliary: QuerySource[] = [
      'compact',
      'side_question',
      'generate_session_title',
      'session_memory',
      'user',
      'unknown',
      'new_unclassified_source',
    ]

    for (const source of agentic)
      expect(isAgenticQuerySource(source)).toBe(true)
    for (const source of auxiliary)
      expect(isAgenticQuerySource(source)).toBe(false)
  })

  test('prepends immutably and exactly once', () => {
    const original = asSystemPrompt(['base prompt'])
    const decorated = withAgenticSystemPromptInvariants(original)
    const decoratedAgain = withAgenticSystemPromptInvariants(decorated)

    expect(original).toEqual(['base prompt'])
    expect(decorated).not.toBe(original)
    expect(decorated[0]).toBe(AGENTIC_SYSTEM_PROMPT_INVARIANTS)
    expect(decorated[1]).toBe('base prompt')
    expect(decoratedAgain).toBe(decorated)
    expect(countInvariant(decoratedAgain.join('\n\n'))).toBe(1)
  })

  test('injects direct agentic prompts but preserves clean auxiliary prompts', () => {
    const original = asSystemPrompt(['replacement prompt'])
    const agentic = withAgenticSystemPromptInvariantsForQuery(original, 'sdk')
    const auxiliary = withAgenticSystemPromptInvariantsForQuery(
      original,
      'side_question',
    )

    expect(countInvariant(agentic.join('\n\n'))).toBe(1)
    expect(agentic).toContain('replacement prompt')
    expect(auxiliary).toBe(original)
    expect(countInvariant(auxiliary.join('\n\n'))).toBe(0)
  })

  test('keeps cache-sharing auxiliary forks byte-identical and idempotent', () => {
    const parent = withAgenticSystemPromptInvariants(
      asSystemPrompt(['parent prompt']),
    )

    for (const source of ['compact', 'side_question'] satisfies QuerySource[]) {
      const fork = withAgenticSystemPromptInvariants(parent)
      const routed = withAgenticSystemPromptInvariantsForQuery(fork, source)

      expect(fork).toBe(parent)
      expect(routed).toBe(parent)
      expect(countInvariant(routed.join('\n\n'))).toBe(1)
    }
  })

  test('states file-content emoji and platform-neutral temp semantics', () => {
    expect(AGENTIC_SYSTEM_PROMPT_INVARIANTS).toContain(
      'including in file contents',
    )
    expect(AGENTIC_SYSTEM_PROMPT_INVARIANTS).toContain(
      'platform-provided temporary directory',
    )
    expect(AGENTIC_SYSTEM_PROMPT_INVARIANTS).toContain(
      '$TMPDIR` on Unix or the platform equivalent',
    )
    expect(AGENTIC_SYSTEM_PROMPT_INVARIANTS).toContain('Never hardcode `/tmp`')
  })

  test('keeps the invariant in the cached system block without adding a block', () => {
    const prompt = asSystemPrompt([
      getCLISyspromptPrefix(),
      AGENTIC_SYSTEM_PROMPT_INVARIANTS,
      'static guidance',
      'dynamic guidance',
    ])

    const splitBlocks = splitSysPromptPrefix(prompt)
    const apiBlocks = buildSystemPromptBlocks(prompt, true, {
      querySource: 'sdk',
    })

    expect(splitBlocks).toHaveLength(2)
    expect(splitBlocks[0]).toEqual({
      text: getCLISyspromptPrefix(),
      cached: false,
    })
    expect(splitBlocks[1]?.cached).toBe(true)
    expect(splitBlocks[1]?.text).toContain(AGENTIC_SYSTEM_PROMPT_INVARIANTS)
    expect(
      splitBlocks[1]?.text.indexOf(AGENTIC_SYSTEM_PROMPT_INVARIANTS),
    ).toBeLessThan(splitBlocks[1]?.text.indexOf('static guidance') ?? -1)
    expect(splitBlocks[1]?.text).toContain('dynamic guidance')
    expect(apiBlocks).toHaveLength(splitBlocks.length)
    expect(apiBlocks[0]?.cache_control).toBeUndefined()
    expect(apiBlocks[1]?.cache_control).toEqual({ type: 'ephemeral' })
  })
})
