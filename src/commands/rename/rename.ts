import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import {
  getTranscriptPath,
  saveAgentName,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'
import { generateSessionName, type NameResult } from './generateSessionName.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Prevent teammates from renaming - their names are set by team leader
  if (isTeammate()) {
    onDone(
      'Cannot rename: This session is a swarm teammate. Teammate names are set by the team leader.',
      { display: 'system' },
    )
    return null
  }

  let newName: string
  if (!args || args.trim() === '') {
    const postCompact = getMessagesAfterCompactBoundary(context.messages)
    let result: NameResult = await generateSessionName(
      postCompact,
      context.abortController.signal,
    )
    if (
      !result.ok &&
      result.reason === 'no_text' &&
      postCompact.length !== context.messages.length
    ) {
      result = await generateSessionName(
        context.messages,
        context.abortController.signal,
      )
    }
    if (!result.ok) {
      const msg =
        result.reason === 'no_text'
          ? 'No conversation context yet.'
          : result.reason === 'model_failed'
            ? 'Could not reach the model for name generation.'
            : 'Model returned an unparseable response.'
      onDone(`${msg} Usage: /rename <name>`, { display: 'system' })
      return null
    }
    newName = result.name
  } else {
    newName = args.trim()
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // Always save the custom title (session name)
  await saveCustomTitle(sessionId, newName, fullPath)

  // Also persist as the session's agent name for prompt-bar display
  await saveAgentName(sessionId, newName, fullPath)
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: newName,
    },
  }))

  onDone(`Session renamed to: ${newName}`, { display: 'system' })
  return null
}
