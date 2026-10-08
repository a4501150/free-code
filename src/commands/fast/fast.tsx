import * as React from 'react'
import type {
  CommandResultDisplay,
  LocalJSXCommandContext,
} from '../../commands.js'
import { FastModePicker as FastModePickerPanel } from '../../components/panels/FastModeDialog/FastModePicker.js'
import { getFastIconString } from '../../components/FastIcon.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  clearFastModeCooldown,
  FAST_MODE_MODEL_DISPLAY,
  getFastModeModel,
  getFastModeUnavailableReason,
  isFastModeEnabled,
  isFastModeSupportedByModel,
  prefetchFastModeStatus,
} from '../../utils/fastMode.js'
import { getModelPricingString } from '../../utils/modelCost.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

function applyFastMode(
  enable: boolean,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  clearFastModeCooldown()
  updateSettingsForSource('userSettings', {
    fastMode: enable ? true : undefined,
  })
  if (enable) {
    setAppState(prev => {
      // Only switch model if current model doesn't support fast mode
      const needsModelSwitch = !isFastModeSupportedByModel(prev.mainLoopModel)
      return {
        ...prev,
        ...(needsModelSwitch
          ? { mainLoopModel: getFastModeModel(), mainLoopModelForSession: null }
          : {}),
        fastMode: true,
      }
    })
  } else {
    setAppState(prev => ({ ...prev, fastMode: false }))
  }
}

/**
 * REPL host adapter for the fast mode picker: reads the model and fast mode
 * flag from the app store and wires the store writes behind typed callbacks
 * for the host-agnostic panel.
 */
export function FastModePicker({
  onDone,
  unavailableReason,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  unavailableReason: string | null
}): React.ReactNode {
  const model = useAppState(s => s.mainLoopModel)
  const initialFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  return (
    <FastModePickerPanel
      onDone={onDone}
      unavailableReason={unavailableReason}
      model={model}
      initialFastMode={initialFastMode}
      onApplyFastMode={(enable: boolean) => applyFastMode(enable, setAppState)}
      onSetFastModeOff={() =>
        setAppState(prev => ({ ...prev, fastMode: false }))
      }
    />
  )
}

async function handleFastModeShortcut(
  enable: boolean,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<string> {
  const unavailableReason = getFastModeUnavailableReason()
  if (unavailableReason) {
    return `Fast mode unavailable: ${unavailableReason}`
  }

  const { mainLoopModel } = getAppState()
  applyFastMode(enable, setAppState)

  if (enable) {
    const fastIcon = getFastIconString(true)
    const modelUpdated = !isFastModeSupportedByModel(mainLoopModel)
      ? ` · model set to ${FAST_MODE_MODEL_DISPLAY}`
      : ''
    const pricing =
      getModelPricingString(getMainLoopModel()) ?? 'pricing unavailable'
    return `${fastIcon} Fast mode ON${modelUpdated} · ${pricing}`
  } else {
    return `Fast mode OFF`
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode | null> {
  if (!isFastModeEnabled()) {
    return null
  }

  // Fetch org fast mode status before showing the picker. We must know
  // whether the org has disabled fast mode before allowing any toggle.
  // If a startup prefetch is already in flight, this awaits it.
  await prefetchFastModeStatus()

  const arg = args?.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    const result = await handleFastModeShortcut(
      arg === 'on',
      context.getAppState,
      context.setAppState,
    )
    onDone(result)
    return null
  }

  const unavailableReason = getFastModeUnavailableReason()
  return (
    <FastModePicker onDone={onDone} unavailableReason={unavailableReason} />
  )
}
