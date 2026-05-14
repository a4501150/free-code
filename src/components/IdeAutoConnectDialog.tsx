import React, { useCallback } from 'react'
import { Text } from '../ink.js'
import { isSupportedTerminal } from '../utils/ide.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type IdeAutoConnectDialogProps = {
  onComplete: () => void
}

export function IdeAutoConnectDialog({
  onComplete,
}: IdeAutoConnectDialogProps): React.ReactNode {
  const handleSelect = useCallback(
    async (value: string) => {
      const autoConnect = value === 'yes'

      // Save the preference.
      updateSettingsForSource('userSettings', { autoConnectIde: autoConnect })

      onComplete()
    },
    [onComplete],
  )

  const options = [
    { label: 'Yes', value: 'yes' },
    { label: 'No', value: 'no' },
  ]

  return (
    <Dialog
      title="Do you wish to enable auto-connect to IDE?"
      color="ide"
      onCancel={onComplete}
    >
      <Select options={options} onChange={handleSelect} defaultValue={'yes'} />
      <Text dimColor>
        You can also configure this in /config or with the --ide flag
      </Text>
    </Dialog>
  )
}

export function shouldShowAutoConnectDialog(): boolean {
  return false
}

type IdeDisableAutoConnectDialogProps = {
  onComplete: (disableAutoConnect: boolean) => void
}

export function IdeDisableAutoConnectDialog({
  onComplete,
}: IdeDisableAutoConnectDialogProps): React.ReactNode {
  const handleSelect = useCallback(
    (value: string) => {
      const disableAutoConnect = value === 'yes'

      if (disableAutoConnect) {
        updateSettingsForSource('userSettings', { autoConnectIde: false })
      }

      onComplete(disableAutoConnect)
    },
    [onComplete],
  )

  const handleCancel = useCallback(() => {
    onComplete(false)
  }, [onComplete])

  const options = [
    { label: 'No', value: 'no' },
    { label: 'Yes', value: 'yes' },
  ]

  return (
    <Dialog
      title="Do you wish to disable auto-connect to IDE?"
      subtitle="You can also configure this in /config"
      onCancel={handleCancel}
      color="ide"
    >
      <Select options={options} onChange={handleSelect} defaultValue={'no'} />
    </Dialog>
  )
}

export function shouldShowDisableAutoConnectDialog(): boolean {
  return !isSupportedTerminal() && getInitialSettings().autoConnectIde === true
}
