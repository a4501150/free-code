import { useOptionalKeybindingContext } from './KeybindingContext.js'
import { getShortcutDisplay } from './shortcutFormat.js'
import type { KeybindingContextName } from './types.js'

/**
 * Hook to get the display text for a configured shortcut.
 * Resolution: user bindings > shipped default binding for the action.
 * Outside a keybinding context, falls through to the non-React resolver
 * (which reads the same bindings file).
 *
 * @param action - The action name (e.g., 'app:toggleTranscript')
 * @param context - The keybinding context (e.g., 'Global')
 * @returns The configured shortcut display text
 *
 * @example
 * const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global')
 * // Returns the user's configured binding, or the default 'ctrl+o'
 */
export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
): string {
  const keybindingContext = useOptionalKeybindingContext()
  return (
    keybindingContext?.getDisplayText(action, context) ??
    getShortcutDisplay(action, context)
  )
}
