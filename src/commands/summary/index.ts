import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import {
  createCompactCanUseTool,
  stripImagesFromMessages,
} from '../../services/compact/compact.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import {
  formatCompactSummary,
  getCompactPrompt,
} from '../../services/compact/prompt.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Command, LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import {
  createUserMessage,
  getAssistantMessageText,
  getLastAssistantMessage,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { runForkedAgent } from '../../utils/forkedAgent.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'

async function buildCacheSafeParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
) {
  const appState = context.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    context.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}

export const call: LocalCommandCall = async (args, context) => {
  const messagesInScope = getMessagesAfterCompactBoundary(context.messages)
  if (messagesInScope.length === 0) {
    return {
      type: 'text',
      value: 'No messages in the current context to summarize.',
    }
  }

  const customInstructions = args.trim() || undefined

  // Microcompact first so the summary reflects what the API actually sees.
  const { messages: compactReadyMessages } = await microcompactMessages(
    messagesInScope,
    context,
  )
  const forkContextMessages = stripImagesFromMessages(compactReadyMessages)

  const cacheSafeParams = await buildCacheSafeParams(
    context,
    forkContextMessages,
  )
  const summaryRequest = createUserMessage({
    content: getCompactPrompt(customInstructions),
  })

  const result = await runForkedAgent({
    promptMessages: [summaryRequest],
    cacheSafeParams,
    canUseTool: createCompactCanUseTool(),
    querySource: 'compact',
    forkLabel: 'summary',
    maxTurns: 1,
    skipCacheWrite: true,
    overrides: { abortController: context.abortController },
  })

  const assistantMsg = getLastAssistantMessage(result.messages)
  const rawText = assistantMsg ? getAssistantMessageText(assistantMsg) : null
  if (!rawText) {
    throw new Error('Summary generation returned no text content')
  }

  return {
    type: 'text',
    value: formatCompactSummary(rawText),
  }
}

const summary = {
  type: 'local',
  name: 'summary',
  description:
    'Summarize the current conversation without modifying context history',
  argumentHint: '[optional focus area]',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default summary
