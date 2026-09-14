import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ContextVisualization } from '../../components/ContextVisualization.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { analyzeContextUsage } from '../../utils/analyzeContext.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { renderToAnsiString } from '../../utils/staticRender.js'

/**
 * Apply the same context transforms query.ts does before the API call, so
 * /context shows what the model actually sees rather than the REPL's raw
 * history.
 */
function toApiView(messages: Message[]): Message[] {
  return getMessagesAfterCompactBoundary(messages)
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools },
  } = context

  const apiView = toApiView(messages)

  // Get terminal width for responsive sizing
  const terminalWidth = process.stdout.columns || 80

  const appState = getAppState()

  // Pass original messages as last parameter for accurate API usage extraction
  const data = await analyzeContextUsage(
    apiView,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    appState.agentDefinitions,
    terminalWidth,
    context, // Pass full context for system prompt calculation
    undefined, // mainThreadAgentDefinition
    apiView, // Original messages for API usage extraction
  )

  // Render to ANSI string to preserve colors and pass to onDone like local commands do
  const output = await renderToAnsiString(<ContextVisualization data={data} />)
  onDone(output)
  return null
}
