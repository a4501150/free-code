import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { formatAgentLine } from '../../src/tools/AgentTool/prompt.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'

// Minimal built-in definition — formatAgentLine reads agentType, whenToUse,
// model, roleConfiguredModel, tools and disallowedTools only.
function testAgent(
  model: string | undefined,
  roleConfiguredModel?: boolean,
): AgentDefinition {
  return {
    agentType: 'TestAgent',
    whenToUse: 'Does test things',
    model,
    ...(roleConfiguredModel ? { roleConfiguredModel } : {}),
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  } as AgentDefinition
}

describe('formatAgentLine effective model display', () => {
  afterEach(() => resetProviderRegistry())

  describe('with defaultSubagentModel set', () => {
    beforeEach(() =>
      initProviderRegistry(
        {},
        {
          defaultModel: 'anthropic:claude-sonnet-4-5',
          defaultSubagentModel: 'anthropic:claude-haiku-4-5',
        },
      ),
    )

    test('agents-dir frontmatter model is replaced by the override', () => {
      const line = formatAgentLine(testAgent('anthropic:claude-opus-4-1'))
      expect(line).toContain('Default model:')
      expect(line).not.toContain('opus')
      expect(line).not.toContain('Opus')
    })

    test('role-configured agents (advisor, plan) advertise their own model', () => {
      const line = formatAgentLine(testAgent('anthropic:claude-opus-4-1', true))
      expect(line).toContain('Default model:')
      expect(line).not.toContain('haiku')
    })

    test('utility sentinel agent advertises the override', () => {
      const line = formatAgentLine(testAgent('utility'))
      expect(line).toContain('Default model:')
      expect(line).not.toContain('gpt')
    })

    test('inherit agents show no model tag', () => {
      expect(formatAgentLine(testAgent(undefined))).not.toContain(
        'Default model:',
      )
    })
  })

  describe('without defaultSubagentModel', () => {
    beforeEach(() =>
      initProviderRegistry({}, { defaultModel: 'anthropic:claude-sonnet-4-5' }),
    )

    test('frontmatter model is advertised as-is', () => {
      const line = formatAgentLine(testAgent('anthropic:claude-opus-4-1'))
      expect(line).toContain('Default model:')
      expect(line).not.toContain('haiku')
    })

    test('inherit keyword frontmatter shows no model tag', () => {
      for (const keyword of ['inherit', 'default', 'parent']) {
        expect(formatAgentLine(testAgent(keyword))).not.toContain(
          'Default model:',
        )
      }
    })
  })
})
