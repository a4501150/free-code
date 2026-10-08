import * as React from 'react'
import { useState } from 'react'
import type { CommandResultDisplay } from '../../../commands.js'
import { Dialog } from '../../design-system/Dialog.js'
import { FastIcon, getFastIconString } from '../../FastIcon.js'
import { Box, Link, Text } from '../../../ink.js'
import { useKeybindings } from '../../../keybindings/useKeybinding.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  getFastModeRuntimeState,
  isFastModeSupportedByModel,
} from '../../../utils/fastMode.js'
import { formatDuration } from '../../../utils/format.js'
import { getModelPricingString } from '../../../utils/modelCost.js'
import {
  getMainLoopModel,
  type ModelSetting,
} from '../../../utils/model/model.js'

export type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  unavailableReason: string | null
  /** The current main-loop model (host-side `AppState.mainLoopModel`). */
  model: ModelSetting
  /** The fast mode flag at mount (host-side `AppState.fastMode`). */
  initialFastMode: boolean | undefined
  /**
   * Applies a fast mode choice host-side (clears cooldown, persists the
   * setting, flips the flag, and switches the model when needed).
   */
  onApplyFastMode: (enable: boolean) => void
  /** Host-side `setAppState(prev => ({ ...prev, fastMode: false }))`. */
  onSetFastModeOff: () => void
}

export function FastModePicker({
  onDone,
  unavailableReason,
  model,
  initialFastMode,
  onApplyFastMode,
  onSetFastModeOff,
}: Props): React.ReactNode {
  const [enableFastMode, setEnableFastMode] = useState(initialFastMode ?? false)
  const runtimeState = getFastModeRuntimeState()
  const isCooldown = runtimeState.status === 'cooldown'
  const isUnavailable = unavailableReason !== null
  const pricing =
    getModelPricingString(getMainLoopModel()) ?? 'pricing unavailable'

  function handleConfirm(): void {
    if (isUnavailable) return
    onApplyFastMode(enableFastMode)
    if (enableFastMode) {
      const fastIcon = getFastIconString(enableFastMode)
      const modelUpdated = !isFastModeSupportedByModel(model)
        ? ` · model set to ${FAST_MODE_MODEL_DISPLAY}`
        : ''
      onDone(`${fastIcon} Fast mode ON${modelUpdated} · ${pricing}`)
    } else {
      onSetFastModeOff()
      onDone(`Fast mode OFF`)
    }
  }

  function handleCancel(): void {
    if (isUnavailable) {
      // Ensure fast mode is off if the org has disabled it
      if (initialFastMode) {
        onApplyFastMode(false)
      }
      onDone('Fast mode OFF', { display: 'system' })
      return
    }
    const message = initialFastMode
      ? `${getFastIconString()} Kept Fast mode ON`
      : `Kept Fast mode OFF`
    onDone(message, { display: 'system' })
  }

  function handleToggle(): void {
    if (isUnavailable) return
    setEnableFastMode(prev => !prev)
  }

  useKeybindings(
    {
      'confirm:yes': handleConfirm,
      'confirm:nextField': handleToggle,
      'confirm:next': handleToggle,
      'confirm:previous': handleToggle,
      'confirm:cycleMode': handleToggle,
      'confirm:toggle': handleToggle,
    },
    { context: 'Confirmation' },
  )

  const title = (
    <Text>
      <FastIcon cooldown={isCooldown} /> Fast mode (research preview)
    </Text>
  )

  return (
    <Dialog
      title={title}
      subtitle={`High-speed mode for ${FAST_MODE_MODEL_DISPLAY}. Billed as extra usage at a premium rate. Separate rate limits apply.`}
      onCancel={handleCancel}
      color="fastMode"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : isUnavailable ? (
          <Text>Esc to cancel</Text>
        ) : (
          <Text>Tab to toggle · Enter to confirm · Esc to cancel</Text>
        )
      }
    >
      {unavailableReason ? (
        <Box marginLeft={2}>
          <Text color="error">{unavailableReason}</Text>
        </Box>
      ) : (
        <>
          <Box flexDirection="column" gap={0} marginLeft={2}>
            <Box flexDirection="row" gap={2}>
              <Text bold>Fast mode</Text>
              <Text
                color={enableFastMode ? 'fastMode' : undefined}
                bold={enableFastMode}
              >
                {enableFastMode ? 'ON ' : 'OFF'}
              </Text>
              <Text dimColor>{pricing}</Text>
            </Box>
          </Box>

          {isCooldown && runtimeState.status === 'cooldown' && (
            <Box marginLeft={2}>
              <Text color="warning">
                {runtimeState.reason === 'overloaded'
                  ? 'Fast mode overloaded and is temporarily unavailable'
                  : "You've hit your fast limit"}
                {' · resets in '}
                {formatDuration(runtimeState.resetAt - Date.now(), {
                  hideTrailingZeros: true,
                })}
              </Text>
            </Box>
          )}
        </>
      )}
      <Text dimColor>
        Learn more:{' '}
        <Link url="https://code.claude.com/docs/en/fast-mode">
          https://code.claude.com/docs/en/fast-mode
        </Link>
      </Text>
    </Dialog>
  )
}
