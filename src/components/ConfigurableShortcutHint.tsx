import * as React from 'react'
import type {
  KeybindingAction,
  KeybindingContextName,
} from '../keybindings/types.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type Props = {
  /** The keybinding action (e.g., 'app:toggleTranscript') */
  action: KeybindingAction
  /** The keybinding context (e.g., 'Global') */
  context: KeybindingContextName
  /** The action description text (e.g., 'expand') */
  description: string
  /** Whether to wrap in parentheses */
  parens?: boolean
  /** Whether to show in bold */
  bold?: boolean
}

/**
 * KeyboardShortcutHint that displays the user-configured shortcut,
 * falling back to the action's shipped default binding.
 *
 * @example
 * <ConfigurableShortcutHint
 *   action="app:toggleTranscript"
 *   context="Global"
 *   description="expand"
 * />
 */
export function ConfigurableShortcutHint({
  action,
  context,
  description,
  parens,
  bold,
}: Props): React.ReactNode {
  const shortcut = useShortcutDisplay(action, context)
  return (
    <KeyboardShortcutHint
      shortcut={shortcut}
      action={description}
      parens={parens}
      bold={bold}
    />
  )
}
