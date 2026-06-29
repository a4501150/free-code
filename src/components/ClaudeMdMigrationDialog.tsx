import React, { useCallback } from 'react'

import { Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onDone(decision: 'yes' | 'no'): void
}

export function ClaudeMdMigrationDialog({ onDone }: Props): React.ReactNode {
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
    <Dialog title="Copy CLAUDE.md to ~/.freecode?" onCancel={handleEscape}>
      <Text>
        Found <Text bold>~/.claude/CLAUDE.md</Text> but no{' '}
        <Text bold>~/.freecode/CLAUDE.md</Text>. Copy it over so your global
        instructions load from the preferred location?
      </Text>
      <Text dimColor>
        ~/.claude/CLAUDE.md will be copied to ~/.freecode/CLAUDE.md. The
        original is not modified.
      </Text>
      <Select
        defaultValue="yes"
        defaultFocusValue="yes"
        options={[
          { label: 'Yes, copy', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
        onChange={value => handleSelection(value as 'yes' | 'no')}
        onCancel={handleEscape}
      />
    </Dialog>
  )
}
