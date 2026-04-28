import React, { useCallback } from 'react'

import { Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onDone(decision: 'yes' | 'no'): void
}

export function MigrationPromptDialog({ onDone }: Props): React.ReactNode {
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
    <Dialog title="Migrate legacy settings?" onCancel={handleEscape}>
      <Text>
        Found legacy <Text bold>~/.claude/settings.json</Text> but no{' '}
        <Text bold>~/.claude/freecode.json</Text>. Migrate now?
      </Text>
      <Text dimColor>
        Your settings.json is not modified. A new freecode.json will be written
        alongside it.
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
