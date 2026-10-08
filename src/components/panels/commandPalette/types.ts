/**
 * Shared types for the slash-command palette (host-agnostic). The palette
 * brain (useTypeahead → CommandPalette) produces SuggestionItems; the
 * renderer (PromptInputFooterSuggestions) and the overlay portal
 * (promptOverlayContext) consume them.
 */
import type { Theme } from '../../../utils/theme.js'

export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  metadata?: unknown
  color?: keyof Theme
}

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'
