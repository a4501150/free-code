import * as React from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  convertEffortValueToLevel,
  type EffortValue,
  getDisplayedEffortLevel,
  getEffortValueDescription,
  getModelEffortLevels,
  isEffortLevel,
  modelSupportsEffort,
  resolveAppliedEffort,
  toPersistableEffort,
} from '../../utils/effort.js'
import { updateProviderModelConfig } from '../../utils/settings/freecodeSettings.js'
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../utils/model/providerRegistry.js'
import { parseModelString } from '../../utils/model/parseModelString.js'
import { renderModelSetting } from '../../utils/model/modelDisplay.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']

type EffortCommandResult = {
  message: string
}

function setEffortValue(
  effortValue: EffortValue,
  model: string,
): EffortCommandResult {
  if (!modelSupportsEffort(model)) {
    return {
      message: `Model ${renderModelSetting(model)} does not support effort levels.`,
    }
  }
  const allowedLevels = getModelEffortLevels(model)
  const level = convertEffortValueToLevel(effortValue)
  if (!allowedLevels.includes(level)) {
    return {
      message:
        `Effort level "${level}" is not supported for ${renderModelSetting(model)}. ` +
        `Supported: ${allowedLevels.join(', ')}.`,
    }
  }
  const persistable = toPersistableEffort(effortValue)
  if (persistable === undefined) {
    return {
      message: `Cannot persist effort value "${effortValue}" for this model.`,
    }
  }
  writeSelectedEffortForModel(model, persistable)
  resetProviderRegistry()
  const description = getEffortValueDescription(effortValue)
  return {
    message: `Set ${renderModelSetting(model)} effort to ${level}: ${description}`,
  }
}

export function showCurrentEffort(model: string): EffortCommandResult {
  const resolved = resolveAppliedEffort(model, undefined)
  if (resolved === undefined) {
    const level = getDisplayedEffortLevel(model)
    return {
      message: `Effort level for ${renderModelSetting(model)}: auto (currently ${level})`,
    }
  }
  const description = getEffortValueDescription(resolved)
  return {
    message: `Current effort for ${renderModelSetting(model)}: ${convertEffortValueToLevel(resolved)} (${description})`,
  }
}

function unsetEffortLevel(model: string): EffortCommandResult {
  writeSelectedEffortForModel(model, undefined)
  resetProviderRegistry()
  return {
    message: `Cleared effort for ${renderModelSetting(model)} (will use the model's default).`,
  }
}

function writeSelectedEffortForModel(
  model: string,
  selectedEffort: EffortValue | undefined,
): void {
  const registry = getProviderRegistry()
  const providerNames = registry.getProviderNames()
  const defaultProvider = registry.getDefaultProviderName() ?? ''
  const parsed = parseModelString(model, providerNames, defaultProvider)
  updateProviderModelConfig(parsed.provider, parsed.modelId, {
    selectedEffort: toPersistableEffort(selectedEffort),
  })
}

export function executeEffort(
  args: string,
  model: string,
): EffortCommandResult {
  const normalized = args.toLowerCase()
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel(model)
  }

  if (!isEffortLevel(normalized)) {
    return {
      message: `Invalid argument: ${args}. Valid options are: low, medium, high, max, xhigh, auto`,
    }
  }

  return setEffortValue(normalized, model)
}

function ShowCurrentEffort({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const model = useMainLoopModel()
  const { message } = showCurrentEffort(model)
  onDone(message)
  return null
}

function ApplyEffortAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (result: string) => void
}): React.ReactNode {
  const model = useMainLoopModel()
  const result = React.useMemo(() => executeEffort(args, model), [args, model])
  React.useEffect(() => {
    onDone(result.message)
  }, [result.message, onDone])
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Usage: /effort [low|medium|high|max|xhigh|auto]\n\nSets the effort level for the current main-loop model. The chosen level is persisted to the model entry in freecode.json.\n\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- max: Maximum capability with deepest reasoning\n- xhigh: Extra-high reasoning for supported models\n- auto: Clear effort and use the model default',
    )
    return
  }

  if (!args || args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />
  }

  return <ApplyEffortAndClose args={args} onDone={onDone} />
}
