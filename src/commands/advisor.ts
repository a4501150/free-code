import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isAdvisorEnabled } from '../utils/advisor.js'
import {
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { getProviderRegistry } from '../utils/model/providerRegistry.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim()

  if (!arg) {
    const config = context.getAppState().settings?.advisorConfig
    const current = config?.advisorModel
    if (!current || !config?.enabled) {
      return {
        type: 'text',
        value:
          'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor anthropic:opus").',
      }
    }
    return {
      type: 'text',
      value: `Advisor: ${current}\nUse "/advisor off" to disable or "/advisor <model>" to change.`,
    }
  }

  if (arg.toLowerCase() === 'unset' || arg.toLowerCase() === 'off') {
    const config = context.getAppState().settings?.advisorConfig
    const prev = config?.advisorModel
    updateSettingsForSource('userSettings', {
      advisorConfig: { enabled: false, advisorModel: prev },
    })
    return {
      type: 'text',
      value: prev
        ? `Advisor disabled (was ${prev}).`
        : 'Advisor already unset.',
    }
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

  return {
    type: 'text',
    value: `Advisor set to ${resolvedModel}.`,
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
