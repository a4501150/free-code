/**
 * External store for the command palette's suggestion state.
 *
 * The palette engine (CommandPalette/useTypeahead) writes; the host reads
 * via useSyncExternalStore so suggestion updates re-render the host and the
 * palette in the SAME commit — required for frame parity with the input
 * line's suggestion-dependent flags (cursor-movement disabling, ghost text,
 * argument hint, notification-box height swap).
 */
import { createStore, type Store } from '../../../state/store.js'
import type { InlineGhostText } from '../../../types/textInputTypes.js'
import type { SuggestionItem } from './types.js'

export type CommandPaletteState = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  commandArgumentHint?: string
  inlineGhostText?: InlineGhostText
}

export type CommandPaletteStore = Store<CommandPaletteState>

export function createCommandPaletteStore(): CommandPaletteStore {
  return createStore<CommandPaletteState>({
    suggestions: [],
    selectedSuggestion: -1,
    commandArgumentHint: undefined,
    inlineGhostText: undefined,
  })
}
