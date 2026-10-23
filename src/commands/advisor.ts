import type { Command } from '../commands.js'
import type {
  LocalCommandCall,
  LocalJSXCommandContext,
} from '../types/command.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getAdvisorConfig, isAdvisorEnabled } from '../utils/advisor.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { getProviderRegistry } from '../utils/model/providerRegistry.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from '../tools/AgentTool/loadAgentsDir.js'

/**
 * Swap freshly loaded agent definitions into app state so an advisor
 * enable/disable applies to the NEXT turn instead of requiring a restart.
 * The agent_listing_delta attachment diffs the new pool against what was
 * already announced in the transcript and tells the model about the
 * change. Mirrors /reload-plugins (refreshActivePlugins), scoped to agent
 * definitions. Returns an error hint on failure, else null.
 */
async function refreshAdvisorAgentPool(
  context: LocalJSXCommandContext,
): Promise<string | null> {
  try {
    clearAgentDefinitionsCache()
    const { activeAgents, allAgents, failedFiles } =
      await getAgentDefinitionsWithOverrides(getOriginalCwd())
    context.setAppState(prev => ({
      ...prev,
      agentDefinitions: {
        activeAgents,
        allAgents,
        ...(failedFiles?.length ? { failedFiles } : {}),
      },
    }))
    return null
  } catch (_error) {
    return 'Settings saved, but refreshing the agent pool failed — restart to apply.'
  }
}

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim()

  if (!arg) {
    // Read via the settings cache, not app state: state.settings is a
    // startup snapshot, so it would report a pre-/advisor value from
    // earlier in this same session.
    const { enabled, advisorModel } = getAdvisorConfig()
    if (!advisorModel || !enabled) {
      return {
        type: 'text',
        value:
          'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor anthropic:opus").',
      }
    }
    return {
      type: 'text',
      value: `Advisor: ${advisorModel}\nUse "/advisor off" to disable or "/advisor <model>" to change.`,
    }
  }

  if (arg.toLowerCase() === 'unset' || arg.toLowerCase() === 'off') {
    const { advisorModel: prev } = getAdvisorConfig()
    const wasEnabled = isAdvisorEnabled()
    updateSettingsForSource('userSettings', {
      advisorConfig: { enabled: false, advisorModel: prev },
    })
    let value = prev
      ? `Advisor disabled (was ${prev}).`
      : 'Advisor already unset.'
    if (wasEnabled) {
      const refreshError = await refreshAdvisorAgentPool(context)
      if (refreshError) value = `${value} ${refreshError}`
    }
    return { type: 'text', value }
  }

  const resolvedModel = parseUserSpecifiedModel(arg)
  const provider = getProviderRegistry().getProviderForModel(resolvedModel)
  if (!provider) {
    const { valid, error } = await validateModel(resolvedModel)
    if (!valid) {
      return {
        type: 'text',
        value: error
          ? `Invalid advisor model: ${error}`
          : `Unknown model: ${arg} (${resolvedModel})`,
      }
    }
  }

  updateSettingsForSource('userSettings', {
    advisorConfig: { enabled: true, advisorModel: resolvedModel },
  })
  const refreshError = await refreshAdvisorAgentPool(context)

  return {
    type: 'text',
    value: refreshError
      ? `Advisor set to ${resolvedModel}. ${refreshError}`
      : `Advisor set to ${resolvedModel}.`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  description: 'Configure the advisor model',
  argumentHint: '[<model>|off]',
  isEnabled: () => true,
  get isHidden() {
    return false
  },
  supportsNonInteractive: true,
  call,
} satisfies Command

export default advisor
