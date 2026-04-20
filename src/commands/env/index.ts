import { release } from 'os'
import type { Command, LocalCommandCall } from '../../types/command.js'
import { getAuthTokenSource } from '../../utils/auth.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getMainLoopModel, getSmallFastModel } from '../../utils/model/modelResolution.js'
import { getProviderRegistry } from '../../utils/model/providerRegistry.js'
import { getProjectsDir } from '../../utils/sessionStorage.js'

function isSecretKey(name: string): boolean {
  return /(TOKEN|KEY|SECRET|PASSWORD)$/i.test(name)
}

function formatEnvValue(name: string, value: string): string {
  return isSecretKey(name) ? '(set)' : value
}

function collectRelevantEnvVars(): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (rawValue === undefined || rawValue === '') continue
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) {
      entries.push([key, formatEnvValue(key, rawValue)])
    }
  }
  entries.sort(([a], [b]) => a.localeCompare(b))
  return entries
}

export const call: LocalCommandCall = async () => {
  const registry = getProviderRegistry()
  const provider = registry.getDefaultProvider()
  const { source: authSource } = getAuthTokenSource()

  const primaryModel = getMainLoopModel()
  const subagentModel = getAgentModel('inherit', primaryModel)
  const smallFastModel = getSmallFastModel()
  const balancedModel = registry.getConfiguredDefaultBalancedModel() ?? '(inherit)'
  const mostPowerfulModel =
    registry.getConfiguredDefaultMostPowerfulModel() ?? '(inherit)'

  const runtime = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`

  const sections: string[] = []

  sections.push(
    'Runtime',
    `  Runtime:  ${runtime}`,
    `  Platform: ${process.platform} ${release()}`,
    `  CWD:      ${process.cwd()}`,
  )

  sections.push(
    '',
    'Build',
    `  Version:    ${MACRO.VERSION}`,
    `  Build time: ${MACRO.BUILD_TIME || '(unknown)'}`,
  )

  sections.push(
    '',
    'Provider',
    `  Active:      ${provider ? `${provider.name} (${provider.config.type})` : '(none)'}`,
    `  Base URL:    ${provider?.config.baseUrl ?? '(default)'}`,
    `  Auth source: ${authSource}`,
  )

  sections.push(
    '',
    'Models',
    `  Primary:       ${primaryModel}`,
    `  Subagent:      ${subagentModel}`,
    `  Small fast:    ${smallFastModel}`,
    `  Balanced:      ${balancedModel}`,
    `  Most powerful: ${mostPowerfulModel}`,
  )

  sections.push(
    '',
    'Paths',
    `  Config dir:   ${getClaudeConfigHomeDir()}`,
    `  Global file:  ${getGlobalClaudeFile()}`,
    `  Projects dir: ${getProjectsDir()}`,
  )

  const envVars = collectRelevantEnvVars()
  sections.push('', 'Relevant env vars (set):')
  if (envVars.length === 0) {
    sections.push('  (none)')
  } else {
    const maxKey = Math.max(...envVars.map(([k]) => k.length))
    for (const [key, value] of envVars) {
      sections.push(`  ${key.padEnd(maxKey)} = ${value}`)
    }
  }

  return {
    type: 'text',
    value: sections.join('\n'),
  }
}

const env = {
  type: 'local',
  name: 'env',
  description: 'Print runtime, provider, model, and environment diagnostics',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default env
