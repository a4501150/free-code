/**
 * Runtime types for the keybinding system. The enum-like lists
 * (KEYBINDING_CONTEXTS, KEYBINDING_ACTIONS) live in
 * src/keybindings/schema.ts because they are the source of truth for the
 * Zod schema as well. We re-derive the union types from those arrays
 * here so consumers can import them without pulling in Zod.
 */

import type {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
} from './schema.js'

/** Valid keybinding context name — keep in sync with KEYBINDING_CONTEXTS. */
export type KeybindingContextName = (typeof KEYBINDING_CONTEXTS)[number]

/**
 * Valid action identifier. The schema also accepts `command:<name>` strings
 * for command bindings, which are runtime-matched and not part of this
 * enum.
 */
export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number]

/**
 * A single parsed keystroke (modifiers + key). Produced by parseKeystroke
 * and matched against Ink `Key` events by match.ts.
 */
export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

/**
 * Ordered list of keystrokes that must be pressed in sequence to trigger
 * a binding (e.g. "ctrl+k ctrl+s" parses to two keystrokes).
 */
export type Chord = ParsedKeystroke[]

/**
 * One parsed binding — a chord bound to an action in a specific context.
 * The action may be a built-in KeybindingAction or a "command:<slashname>"
 * string (validated by the Zod schema).
 */
export type ParsedBinding = {
  context: KeybindingContextName
  chord: Chord
  action: string
}

/**
 * Raw block read from keybindings.json (or the default set) — a context
 * with a map of keystroke patterns to actions. This matches
 * KeybindingBlockSchema.
 */
export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}
