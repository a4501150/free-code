import React, { useCallback } from 'react'

import { Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onDone(decision: 'yes' | 'no'): void
}

export function ConfigDirMigrationDialog({ onDone }: Props): React.ReactNode {
  const handleSelection = useCallback(
    (value: 'yes' | 'no') => {
      onDone(value)
    },
    [onDone],
  )

  const handleEscape = useCallback(() => {
    handleSelection('no')
  }, [handleSelection])

  return (
    <Dialog title="Migrate config directory?" onCancel={handleEscape}>
      <Text>
        Found existing config in <Text bold>~/.claude/</Text>. The config
        directory has moved to <Text bold>~/.freecode/</Text>. Migrate now?
      </Text>
      <Text dimColor>
        Your ~/.claude/ directory will be copied to ~/.freecode/. The original
        is not modified.
      </Text>
      <Select
        defaultValue="yes"
        defaultFocusValue="yes"
        options={[
          { label: 'Yes, migrate', value: 'yes' },
          { label: 'No, start fresh', value: 'no' },
        ]}
        onChange={value => handleSelection(value as 'yes' | 'no')}
        onCancel={handleEscape}
      />
    </Dialog>
  )
}
