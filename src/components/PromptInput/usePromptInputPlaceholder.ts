import { feature } from 'bun:bundle'
import { useMemo } from 'react'
import { useCommandQueue } from 'src/hooks/useCommandQueue.js'
import { useAppState } from 'src/state/AppState.js'
import { getExampleCommandFromCache } from 'src/utils/exampleCommands.js'
import { isQueuedCommandEditable } from 'src/utils/messageQueueManager.js'

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('KAIROS')
  ? require('../../proactive/index.js')
  : null

type Props = {
  input: string
  submitCount: number
  viewingAgentName?: string
}

const MAX_TEAMMATE_NAME_LENGTH = 20

export function usePromptInputPlaceholder({
  input,
  submitCount,
  viewingAgentName,
}: Props): string | undefined {
  const queuedCommands = useCommandQueue()
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled)
  const placeholder = useMemo(() => {
    if (input !== '') {
      return
    }

    // Show teammate hint when viewing teammate
    if (viewingAgentName) {
      const displayName =
        viewingAgentName.length > MAX_TEAMMATE_NAME_LENGTH
          ? viewingAgentName.slice(0, MAX_TEAMMATE_NAME_LENGTH - 3) + '...'
          : viewingAgentName
      return `Message @${displayName}…`
    }

    // Show queue hint when user-editable commands are queued — task-notification
    // and isMeta commands are hidden from the prompt area (see PromptInputQueuedCommands).
    if (queuedCommands.some(isQueuedCommandEditable)) {
      return 'Press up to edit queued messages'
    }

    // Show example command if user has not submitted yet and suggestions are enabled.
    // Skip in proactive mode — the model drives the conversation so onboarding
    // examples are irrelevant and block prompt suggestions from showing.
    if (
      submitCount < 1 &&
      promptSuggestionEnabled &&
      !proactiveModule?.isProactiveActive()
    ) {
      return getExampleCommandFromCache()
    }
  }, [
    input,
    queuedCommands,
    submitCount,
    promptSuggestionEnabled,
    viewingAgentName,
  ])

  return placeholder
}
