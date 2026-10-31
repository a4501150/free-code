import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { GENERAL_PURPOSE_AGENT } from '../../src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { getPrompt } from '../../src/tools/AgentTool/prompt.js'
import { resolveOmittedSubagentType } from '../../src/tools/AgentTool/resolveOmittedSubagentType.js'
import type { AgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'

function fakeAgent(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `${agentType} test agent`,
    tools: ['*'],
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => 'test prompt',
  }
}

describe('resolveOmittedSubagentType', () => {
  test('single non-general-purpose agent is the fallback', () => {
    expect(resolveOmittedSubagentType([fakeAgent('scout')])).toBe('scout')
  })

  test('general-purpose stays the default when registered', () => {
    expect(
      resolveOmittedSubagentType([
        GENERAL_PURPOSE_AGENT,
        fakeAgent('plan'),
        fakeAgent('fork'),
      ]),
    ).toBe(GENERAL_PURPOSE_AGENT.agentType)
    // Even alone it resolves to itself, not through the single-agent rule.
    expect(resolveOmittedSubagentType([GENERAL_PURPOSE_AGENT])).toBe(
      GENERAL_PURPOSE_AGENT.agentType,
    )
  })

  test('multiple agents without general-purpose resolve to a not-found type so the caller errors', () => {
    const agents = [fakeAgent('plan'), fakeAgent('fork')]
    const resolved = resolveOmittedSubagentType(agents)
    // No principled guess: the result is deliberately not among the agents,
    // so AgentTool.call's lookup fails with the "Available agents:" error.
    expect(agents.some(a => a.agentType === resolved)).toBe(false)
    expect(resolved).toBe(GENERAL_PURPOSE_AGENT.agentType)
  })

  test('empty registry resolves to a not-found type', () => {
    expect(resolveOmittedSubagentType([])).toBe(GENERAL_PURPOSE_AGENT.agentType)
  })

  test('the call site uses the mode-aware fallback, not a bare general-purpose default', () => {
    // Guards against regressing to `subagent_type ?? GENERAL_PURPOSE_AGENT`.
    const source = readFileSync(
      join(process.cwd(), 'src/tools/AgentTool/AgentTool.tsx'),
      'utf8',
    )
    expect(source).toContain('resolveOmittedSubagentType(agents)')
    expect(source).not.toContain(
      'subagent_type ?? GENERAL_PURPOSE_AGENT.agentType',
    )
    expect(source).toContain('not found. Available agents:')
  })
})

describe('Agent tool prompt subagent_type sentence', () => {
  // The prompt is mode-agnostic: coordinator mode runs the same registry and
  // the same Agent-tool description as normal mode.
  test('prompt always advertises general-purpose as the omitted default', async () => {
    const prompt = await getPrompt([GENERAL_PURPOSE_AGENT])
    expect(prompt).toContain('when omitted, the general-purpose agent is used')
    expect(prompt).toContain('subagent_type')
  })
})
