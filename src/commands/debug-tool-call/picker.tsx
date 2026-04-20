import * as React from 'react'
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import type { MessageLookups } from '../../utils/messages.js'

type Props = {
  lookups: MessageLookups
  onSelect: (toolUseID: string) => void
  onCancel: () => void
}

const MAX_INPUT_SUMMARY = 80

function summarizeInput(input: unknown): string {
  try {
    const serialized = typeof input === 'string' ? input : JSON.stringify(input)
    if (serialized.length <= MAX_INPUT_SUMMARY) return serialized
    return `${serialized.slice(0, MAX_INPUT_SUMMARY)}…`
  } catch {
    return '(unserializable input)'
  }
}

function shortenId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 8)}…`
}

export function DebugToolCallPicker({
  lookups,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const entries = React.useMemo(() => {
    const arr = Array.from(lookups.toolUseByToolUseID.entries())
    // Most recent last in the Map insertion order; surface newest first.
    arr.reverse()
    return arr
  }, [lookups])

  const options = React.useMemo<OptionWithDescription<string>[]>(
    () =>
      entries.map(([id, toolUse]) => {
        const hasResult = lookups.toolResultByToolUseID.has(id)
        const errored = lookups.erroredToolUseIDs.has(id)
        const status = !hasResult ? 'pending' : errored ? 'error' : 'ok'
        return {
          label: `${toolUse.name} — ${summarizeInput(toolUse.input)}`,
          value: id,
          description: `id ${shortenId(id)} · ${status}`,
        }
      }),
    [entries, lookups],
  )

  return (
    <Dialog title="Select a tool call to inspect" onCancel={onCancel}>
      <Select<string>
        options={options}
        onChange={onSelect}
        onCancel={onCancel}
        visibleOptionCount={Math.min(10, options.length)}
        layout="compact"
      />
    </Dialog>
  )
}
