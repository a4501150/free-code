import { loadKeybindingsSync } from './loadUserBindings.js'
import { getBindingDisplayText } from './resolver.js'
import type { KeybindingContextName } from './types.js'

/**
 * Get the display text for a configured shortcut without React hooks.
 * Use this in non-React contexts (commands, services, etc.).
 *
 * This lives in its own module (not useShortcutDisplay.ts) so that
 * non-React callers like query/stopHooks.ts don't pull React into their
 * module graph via the sibling hook.
 *
 * Resolution order: user bindings (which already layer over the shipped
 * defaults), then the shipped default binding for the action. An empty
 * string means the action has no binding to display (custom or unshipped
 * actions only — every built-in action has a default).
 *
 * @param action - The action name (e.g., 'app:toggleTranscript')
 * @param context - The keybinding context (e.g., 'Global')
 * @returns The configured shortcut display text
 *
 * @example
 * const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global')
 * // Returns the user's configured binding, or the default 'ctrl+o'
 */
export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
): string {
  return getBindingDisplayText(action, context, loadKeybindingsSync()) ?? ''
}
