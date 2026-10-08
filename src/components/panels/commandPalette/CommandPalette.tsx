/**
 * CommandPalette — the host-agnostic slash-command palette: suggestion
 * computation, selection/dismissal, ghost text, the Autocomplete keybinding
 * context, and the floating-overlay publish (via promptOverlayContext —
 * no-op outside a provider, so hosts without the portal render nothing
 * floating). Renders nothing itself.
 *
 * Suggestion state lives in a palette-owned external store (paletteStore)
 * passed in by the host; the host reads the same store via
 * useSyncExternalStore so its suggestion-dependent rendering (input flags,
 * ghost text, argument hint) updates in the same commit as the palette.
 * Key events flow through the imperative handle so the host's dispatch
 * order is preserved exactly.
 */
import * as React from 'react'
import { forwardRef, memo, useImperativeHandle, useMemo } from 'react'

import { useSetPromptOverlay } from '../../../context/promptOverlayContext.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import type { Command } from '../../../commands.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { PromptInputMode } from '../../../types/textInputTypes.js'
import type { TypeaheadDataSources } from './dataSources.js'
import type { CommandPaletteStore } from './paletteStore.js'
import { useTypeahead } from './useTypeahead.js'

export type CommandPaletteHandle = {
  /** Compose into the host's key dispatch — see PromptInput's handlePromptKeyDown. */
  handleKeyDown: (e: KeyboardEvent) => void
}

type Props = {
  store: CommandPaletteStore
  commands: Command[]
  agents: AgentDefinition[]
  input: string
  cursorOffset: number
  mode: PromptInputMode
  suppressSuggestions?: boolean
  dataSources: TypeaheadDataSources
  onInputChange: (value: string) => void
  setCursorOffset: (offset: number) => void
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void
  markAccepted: () => void
  onModeChange?: (mode: PromptInputMode) => void
}

export const CommandPalette = memo(
  forwardRef<CommandPaletteHandle, Props>(function CommandPalette(
    {
      store,
      commands,
      agents,
      input,
      cursorOffset,
      mode,
      suppressSuggestions,
      dataSources,
      onInputChange,
      setCursorOffset,
      onSubmit,
      markAccepted,
      onModeChange,
    },
    ref,
  ): React.ReactNode {
    const { suggestionsState, maxColumnWidth, handleKeyDown } = useTypeahead({
      store,
      commands,
      agents,
      input,
      cursorOffset,
      mode,
      suppressSuggestions,
      dataSources,
      onInputChange,
      setCursorOffset,
      onSubmit,
      markAccepted,
      onModeChange,
    })

    const overlayData = useMemo(
      () =>
        suggestionsState.suggestions.length
          ? {
              suggestions: suggestionsState.suggestions,
              selectedSuggestion: suggestionsState.selectedSuggestion,
              maxColumnWidth,
            }
          : null,
      [
        suggestionsState.suggestions,
        suggestionsState.selectedSuggestion,
        maxColumnWidth,
      ],
    )
    useSetPromptOverlay(overlayData)

    // No deps: recreate every render so the host always calls the closure
    // matching the committed state (same guarantee the hook return gave).
    useImperativeHandle(ref, () => ({ handleKeyDown }))

    return null
  }),
)
