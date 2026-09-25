import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): Remove the fallback parameter once callers can
// trust the resolver to return a value for every known action. Blocker:
// getDisplayText still returns `string | undefined` and every call site passes
// a hardcoded fallback — removal needs the resolver (and its binding-loading
// failure path) to guarantee a non-undefined result first.

/**
 * Hook to get the display text for a configured shortcut.
 * Returns the configured binding or a fallback if unavailable.
 *
 * @param action - The action name (e.g., 'app:toggleTranscript')
 * @param context - The keybinding context (e.g., 'Global')
 * @param fallback - Fallback text if keybinding context unavailable
 * @returns The configured shortcut display text
 *
 * @example
 * const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // Returns the user's configured binding, or 'ctrl+o' as default
 */
export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const keybindingContext = useOptionalKeybindingContext()
  const resolved = keybindingContext?.getDisplayText(action, context)
  return resolved ?? fallback
}
