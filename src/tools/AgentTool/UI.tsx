import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { ConfigurableShortcutHint } from 'src/components/ConfigurableShortcutHint.js'
import {
  CtrlOToExpand,
  SubAgentProvider,
} from 'src/components/CtrlOToExpand.js'
import { Byline } from 'src/components/design-system/Byline.js'
import { KeyboardShortcutHint } from 'src/components/design-system/KeyboardShortcutHint.js'
import type { z } from 'zod/v4'
import { AgentProgressLine } from '../../components/AgentProgressLine.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { Markdown } from '../../components/Markdown.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolUseLoader } from '../../components/ToolUseLoader.js'
import { Box, Text, useTheme } from '../../ink.js'
import {
  useIsAgentToolUseExpanded,
  useToggleAgentToolUseExpansion,
} from '../../state/agentExpansion.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { findToolByName, type Tools } from '../../Tool.js'
import type { Message, ProgressMessage } from '../../types/message.js'
import type { AgentToolProgress } from '../../types/tools.js'
import { count } from '../../utils/array.js'
import {
  getSearchOrReadFromContent,
  getSearchReadSummaryText,
} from '../../utils/collapseReadSearch.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import {
  buildSubagentLookups,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  EMPTY_LOOKUPS,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
  renderModelName,
} from '../../utils/model/model.js'
import type { Theme, ThemeName } from '../../utils/theme.js'
import type { outputSchema, Progress } from './AgentTool.js'
import { inputSchema } from './AgentTool.js'
import { getAgentColor } from './agentColorManager.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

const MAX_PROGRESS_MESSAGES_TO_SHOW = 3

/**
 * Map a subagent errorReason to a short user-facing label for the
 * completion line (e.g. "Stopped: output token limit"). Unknown reasons
 * fall back to the raw enum value so we never hide the signal.
 */
function formatErrorReason(reason: string): string {
  switch (reason) {
    case 'max_output_tokens':
      return 'output token limit'
    case 'context_window_exceeded':
      return 'context window exceeded'
    case 'rate_limit':
      return 'rate limit'
    case 'server_error':
      return 'server error'
    case 'invalid_request':
      return 'invalid request'
    case 'authentication_failed':
      return 'authentication failed'
    case 'billing_error':
      return 'billing error'
    case 'unknown':
      return 'unknown error'
    default:
      return reason
  }
}

/**
 * Guard: checks if progress data has a `message` field (agent_progress or
 * skill_progress).  Other progress types (e.g. bash_progress forwarded from
 * sub-agents) lack this field and must be skipped by UI helpers.
 */
function hasProgressMessage(data: Progress): data is AgentToolProgress {
  if (!('message' in data)) {
    return false
  }
  const msg = (data as AgentToolProgress).message
  return msg != null && typeof msg === 'object' && 'type' in msg
}

/**
 * Check if a progress message is a search/read/REPL operation (tool use or result).
 * Returns { isSearch, isRead, isREPL } if it's a collapsible operation, null otherwise.
 *
 * For tool_result messages, uses the provided `toolUseByID` map to find the
 * corresponding tool_use block instead of relying on `normalizedMessages`.
 */
function getSearchOrReadInfo(
  progressMessage: ProgressMessage<Progress>,
  tools: Tools,
  toolUseByID: Map<string, ToolUseBlockParam>,
): { isSearch: boolean; isRead: boolean; isREPL: boolean } | null {
  if (!hasProgressMessage(progressMessage.data)) {
    return null
  }
  const message = progressMessage.data.message

  // Check tool_use (assistant message)
  if (message.type === 'assistant') {
    return getSearchOrReadFromContent(message.message.content[0], tools)
  }

  // Check tool_result (user message) - find corresponding tool use from the map
  if (message.type === 'user') {
    const content = message.message.content[0]
    if (content?.type === 'tool_result') {
      const toolUse = toolUseByID.get(content.tool_use_id)
      if (toolUse) {
        return getSearchOrReadFromContent(toolUse, tools)
      }
    }
  }

  return null
}

type SummaryMessage = {
  type: 'summary'
  searchCount: number
  readCount: number
  replCount: number
  uuid: string
  isActive: boolean // true if still in progress (last message was tool_use, not tool_result)
}

type ProcessedMessage =
  | { type: 'original'; message: ProgressMessage<AgentToolProgress> }
  | SummaryMessage

/**
 * Filter progress messages down to non-user assistant-side entries in their
 * original form. (Earlier revisions also supported a grouped-summary path
 * for consecutive search/read operations; that path has been removed.)
 */
function processProgressMessages(
  messages: ProgressMessage<Progress>[],
  _tools: Tools,
  _isAgentRunning: boolean,
): ProcessedMessage[] {
  return messages
    .filter(
      (m): m is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(m.data) && m.data.message.type !== 'user',
    )
    .map(m => ({ type: 'original', message: m }))
}

const ESTIMATED_LINES_PER_TOOL = 9
const TERMINAL_BUFFER_LINES = 7

type Output = z.input<ReturnType<typeof outputSchema>>

export function AgentPromptDisplay({
  prompt,
  dim: _dim = false,
}: {
  prompt: string
  theme?: ThemeName // deprecated, kept for compatibility - Markdown uses useTheme internally
  dim?: boolean // deprecated, kept for compatibility - dimColor cannot be applied to Box (Markdown returns Box)
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="success" bold>
        Prompt:
      </Text>
      <Box paddingLeft={2}>
        <Markdown>{prompt}</Markdown>
      </Box>
    </Box>
  )
}

export function AgentResponseDisplay({
  content,
}: {
  content: { type: string; text: string }[]
  theme?: ThemeName // deprecated, kept for compatibility - Markdown uses useTheme internally
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="success" bold>
        Response:
      </Text>
      {content.map((block: { type: string; text: string }, index: number) => (
        <Box key={index} paddingLeft={2} marginTop={index === 0 ? 0 : 1}>
          <Markdown>{block.text}</Markdown>
        </Box>
      ))}
    </Box>
  )
}

type VerboseAgentTranscriptProps = {
  progressMessages: ProgressMessage<Progress>[]
  tools: Tools
  verbose: boolean
}

function VerboseAgentTranscript({
  progressMessages,
  tools,
  verbose,
}: VerboseAgentTranscriptProps): React.ReactNode {
  const { lookups: agentLookups, inProgressToolUseIDs } = buildSubagentLookups(
    progressMessages
      .filter((pm): pm is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(pm.data),
      )
      .map(pm => pm.data),
  )

  // Filter out user tool_result messages that lack toolUseResult.
  // Subagent progress messages don't carry the parsed tool output,
  // so UserToolSuccessMessage returns null and MessageResponse renders
  // a bare ⎿ with no content.
  const filteredMessages = progressMessages.filter(
    (pm): pm is ProgressMessage<AgentToolProgress> => {
      if (!hasProgressMessage(pm.data)) {
        return false
      }
      const msg = pm.data.message
      if (msg.type === 'user' && msg.toolUseResult === undefined) {
        return false
      }
      return true
    },
  )

  return (
    <>
      {filteredMessages.map(progressMessage => (
        <MessageResponse key={progressMessage.uuid} height={1}>
          <MessageComponent
            message={progressMessage.data.message}
            lookups={agentLookups}
            addMargin={false}
            tools={tools}
            commands={[]}
            verbose={verbose}
            inProgressToolUseIDs={inProgressToolUseIDs}
            progressMessagesForMessage={[]}
            shouldAnimate={false}
            shouldShowDot={false}
            isTranscriptMode={false}
            isStatic={true}
          />
        </MessageResponse>
      ))}
    </>
  )
}

export function renderToolResultMessage(
  data: Output,
  progressMessagesForMessage: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
    theme,
    isTranscriptMode = false,
    toolUseId,
  }: {
    tools: Tools
    verbose: boolean
    theme: ThemeName
    isTranscriptMode?: boolean
    toolUseId?: string
  },
): React.ReactNode {
  if (data.status === 'async_launched') {
    const { prompt } = data
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Backgrounded agent
            {!isTranscriptMode && (
              <Text dimColor>
                {' ('}
                <Byline>
                  <KeyboardShortcutHint shortcut="↓" action="manage" />
                  {prompt && (
                    <ConfigurableShortcutHint
                      action="app:toggleTranscript"
                      context="Global"
                      fallback="ctrl+o"
                      description="expand"
                    />
                  )}
                </Byline>
                {')'}
              </Text>
            )}
          </Text>
        </MessageResponse>
        {isTranscriptMode && prompt && (
          <MessageResponse>
            <AgentPromptDisplay prompt={prompt} theme={theme} />
          </MessageResponse>
        )}
      </Box>
    )
  }

  if (data.status !== 'completed') {
    return null
  }

  const {
    agentId,
    totalDurationMs,
    totalToolUseCount,
    totalTokens,
    usage,
    content,
    prompt,
    errorReason,
  } = data
  const result = [
    totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`,
    formatNumber(totalTokens) + ' tokens',
    formatDuration(totalDurationMs),
  ]

  const label = errorReason
    ? `Stopped: ${formatErrorReason(errorReason)}`
    : 'Done'
  const completionMessage = `${label} (${result.join(' · ')})`

  const finalAssistantMessage = errorReason
    ? createAssistantAPIErrorMessage({ content: completionMessage })
    : createAssistantMessage({
        content: completionMessage,
        usage: { ...usage, inference_geo: null, iterations: null, speed: null },
      })

  const doneLine = (
    <Box flexDirection="row">
      <MessageResponse height={1}>
        <MessageComponent
          message={finalAssistantMessage}
          lookups={EMPTY_LOOKUPS}
          addMargin={false}
          tools={tools}
          commands={[]}
          verbose={verbose}
          inProgressToolUseIDs={new Set()}
          progressMessagesForMessage={[]}
          shouldAnimate={false}
          shouldShowDot={false}
          isTranscriptMode={false}
          isStatic={true}
        />
      </MessageResponse>
      {!isTranscriptMode && <CtrlOToExpand />}
    </Box>
  )

  if (isTranscriptMode) {
    return (
      <Box flexDirection="column">
        {prompt && (
          <MessageResponse>
            <AgentPromptDisplay prompt={prompt} theme={theme} />
          </MessageResponse>
        )}
        <SubAgentProvider>
          <VerboseAgentTranscript
            progressMessages={progressMessagesForMessage}
            tools={tools}
            verbose={verbose}
          />
        </SubAgentProvider>
        {content && content.length > 0 && (
          <MessageResponse>
            <AgentResponseDisplay content={content} theme={theme} />
          </MessageResponse>
        )}
        {doneLine}
      </Box>
    )
  }

  if (!toolUseId) {
    return <Box flexDirection="column">{doneLine}</Box>
  }

  return (
    <ExpandableSingleAgentResult
      toolUseId={toolUseId}
      prompt={prompt}
      content={content}
      progressMessages={progressMessagesForMessage}
      tools={tools}
      verbose={verbose}
    >
      {doneLine}
    </ExpandableSingleAgentResult>
  )
}

/**
 * Click-to-expand wrapper for the completed single-agent view. When
 * expanded: prompt + last 3 tool calls + response + Done(…) line.
 * Collapsed: the existing Done(…) one-liner.
 */
function ExpandableSingleAgentResult({
  toolUseId,
  prompt,
  content,
  progressMessages,
  tools,
  verbose,
  children,
}: {
  toolUseId: string
  prompt: string | undefined
  content: { type: string; text: string }[] | undefined
  progressMessages: ProgressMessage<Progress>[]
  tools: Tools
  verbose: boolean
  children: React.ReactNode
}): React.ReactNode {
  const expanded = useIsAgentToolUseExpanded(toolUseId)
  const toggle = useToggleAgentToolUseExpansion(toolUseId)

  if (!expanded) {
    return (
      <Box flexDirection="column" onClick={toggle}>
        {children}
      </Box>
    )
  }

  // Reuse the same processor the live progress view uses so grouped
  // search/read summaries render consistently. isAgentRunning=false
  // since the agent has completed; any trailing group flushes as inactive.
  const processed = processProgressMessages(progressMessages, tools, false)
  const displayedMessages = processed.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)
  const {
    lookups: subagentLookups,
    inProgressToolUseIDs: collapsedInProgressIDs,
  } = buildSubagentLookups(
    progressMessages
      .filter((pm): pm is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(pm.data),
      )
      .map(pm => pm.data),
  )

  return (
    <Box flexDirection="column" onClick={toggle}>
      {prompt && (
        <MessageResponse>
          <Box marginBottom={1}>
            <AgentPromptDisplay prompt={prompt} />
          </Box>
        </MessageResponse>
      )}
      {displayedMessages.length > 0 && (
        <MessageResponse>
          <Box flexDirection="column">
            <SubAgentProvider>
              {displayedMessages.map(p => {
                if (p.type === 'summary') {
                  const summaryText = getSearchReadSummaryText(
                    p.searchCount,
                    p.readCount,
                    p.isActive,
                    p.replCount,
                  )
                  return (
                    <Box key={p.uuid} height={1} overflow="hidden">
                      <Text dimColor>{summaryText}</Text>
                    </Box>
                  )
                }
                return (
                  <MessageComponent
                    key={p.message.uuid}
                    message={p.message.data.message}
                    lookups={subagentLookups}
                    addMargin={false}
                    tools={tools}
                    commands={[]}
                    verbose={verbose}
                    inProgressToolUseIDs={collapsedInProgressIDs}
                    progressMessagesForMessage={[]}
                    shouldAnimate={false}
                    shouldShowDot={false}
                    style="condensed"
                    isTranscriptMode={false}
                    isStatic={true}
                  />
                )
              })}
            </SubAgentProvider>
          </Box>
        </MessageResponse>
      )}
      {content && content.length > 0 && (
        <MessageResponse>
          <Box marginTop={1} marginBottom={1}>
            <AgentResponseDisplay content={content} />
          </Box>
        </MessageResponse>
      )}
      {children}
    </Box>
  )
}

export function renderToolUseMessage({
  description,
  prompt,
}: Partial<{
  description: string
  prompt: string
}>): React.ReactNode {
  if (!description || !prompt) {
    return null
  }
  return description
}

export function renderToolUseTag(
  input: Partial<{
    description: string
    prompt: string
    subagent_type: string
    model?: string
  }>,
): React.ReactNode {
  const tags: React.ReactNode[] = []

  if (input.model) {
    const mainModel = getMainLoopModel()
    const agentModel = parseUserSpecifiedModel(input.model)
    if (agentModel !== mainModel) {
      tags.push(
        <Box key="model" flexWrap="nowrap" marginLeft={1}>
          <Text dimColor>{renderModelName(agentModel)}</Text>
        </Box>,
      )
    }
  }

  if (tags.length === 0) {
    return null
  }

  return <>{tags}</>
}

/**
 * Agent-aware version of renderToolUseTag that resolves the effective model
 * using the agent definition's model field. Called from AssistantToolUseMessage
 * when the tool is AgentTool, so the model tag shows even when the LLM
 * doesn't explicitly pass a model parameter.
 */
export function renderAgentToolUseTag(
  input: Partial<{
    description: string
    prompt: string
    subagent_type: string
    model?: string
  }>,
  agentDefinitionModel: string | undefined,
): React.ReactNode {
  const mainModel = getMainLoopModel()
  const effectiveModel = getAgentModel(
    agentDefinitionModel,
    mainModel,
    input.model,
  )

  if (effectiveModel !== mainModel) {
    return (
      <Box flexWrap="nowrap" marginLeft={1}>
        <Text dimColor>{effectiveModel}</Text>
      </Box>
    )
  }

  return null
}

const INITIALIZING_TEXT = 'Initializing…'

export function calculateAgentProgressTokens(
  progressMessages: ProgressMessage<Progress>[],
): number | null {
  const usageByMessageId = new Map<
    string,
    { inputTokens: number; outputTokens: number }
  >()

  for (const progressMessage of progressMessages) {
    if (
      !hasProgressMessage(progressMessage.data) ||
      progressMessage.data.message.type !== 'assistant'
    ) {
      continue
    }

    const assistantMessage = progressMessage.data.message.message
    const usage = assistantMessage.usage
    const inputTokens =
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.input_tokens
    const outputTokens = usage.output_tokens
    if (inputTokens === 0 && outputTokens === 0) {
      continue
    }

    usageByMessageId.set(assistantMessage.id, { inputTokens, outputTokens })
  }

  if (usageByMessageId.size === 0) {
    return null
  }

  let latestInputTokens = 0
  let cumulativeOutputTokens = 0
  for (const usage of usageByMessageId.values()) {
    latestInputTokens = usage.inputTokens
    cumulativeOutputTokens += usage.outputTokens
  }

  const totalTokens = latestInputTokens + cumulativeOutputTokens
  return totalTokens > 0 ? totalTokens : null
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
    terminalSize,
    inProgressToolCallCount,
    isTranscriptMode = false,
    toolUseId,
    isAgentRunning = true,
  }: {
    tools: Tools
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
    toolUseId?: string
    isAgentRunning?: boolean
  },
): React.ReactNode {
  if (!progressMessages.length) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>
    )
  }

  // Checks to see if we should show a super condensed progress message summary.
  // This prevents flickers when the terminal size is too small to render all the dynamic content
  const toolToolRenderLinesEstimate =
    (inProgressToolCallCount ?? 1) * ESTIMATED_LINES_PER_TOOL +
    TERMINAL_BUFFER_LINES
  const shouldUseCondensedMode =
    !isTranscriptMode &&
    terminalSize &&
    terminalSize.rows &&
    terminalSize.rows < toolToolRenderLinesEstimate

  const getProgressStats = () => {
    const toolUseCount = count(progressMessages, msg => {
      if (!hasProgressMessage(msg.data)) {
        return false
      }
      const message = msg.data.message
      if (message.type !== 'assistant' && message.type !== 'user') return false
      const content = message.message.content
      if (!Array.isArray(content)) return false
      return content.some(c => c.type === 'tool_use')
    })

    return {
      toolUseCount,
      tokens: calculateAgentProgressTokens(progressMessages),
    }
  }

  if (shouldUseCondensedMode) {
    const { toolUseCount, tokens } = getProgressStats()
    const statusText = isAgentRunning ? 'In progress…' : 'Stopped'

    return (
      <MessageResponse height={1}>
        <Text dimColor>
          {statusText} · <Text bold>{toolUseCount}</Text> tool{' '}
          {toolUseCount === 1 ? 'use' : 'uses'}
          {tokens && ` · ${formatNumber(tokens)} tokens`} ·{' '}
          <ConfigurableShortcutHint
            action="app:toggleTranscript"
            context="Global"
            fallback="ctrl+o"
            description="expand"
            parens
          />
        </Text>
      </MessageResponse>
    )
  }

  // Process messages to group consecutive search/read operations into summaries (ants only)
  const processedMessages = processProgressMessages(
    progressMessages,
    tools,
    isAgentRunning,
  )

  // For display, take the last few processed messages
  const displayedMessages = isTranscriptMode
    ? processedMessages
    : processedMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)

  // Count hidden tool uses specifically (not all messages) to match the
  // final "Done (N tool uses)" count. Each tool use generates multiple
  // progress messages (tool_use + tool_result + text), so counting all
  // hidden messages inflates the number shown to the user.
  const hiddenMessages = isTranscriptMode
    ? []
    : processedMessages.slice(
        0,
        Math.max(0, processedMessages.length - MAX_PROGRESS_MESSAGES_TO_SHOW),
      )
  const hiddenToolUseCount = count(hiddenMessages, m => {
    if (m.type === 'summary') {
      return m.searchCount + m.readCount + m.replCount > 0
    }
    const data = m.message.data
    if (!hasProgressMessage(data)) {
      return false
    }
    const msg = data.message
    if (msg.type !== 'assistant' && msg.type !== 'user') return false
    const content = msg.message.content
    if (!Array.isArray(content)) return false
    return content.some(c => c.type === 'tool_use')
  })

  const firstData = progressMessages[0]?.data
  const prompt =
    firstData && hasProgressMessage(firstData) ? firstData.prompt : undefined

  // After grouping, displayedMessages can be empty when the only progress so
  // far is an assistant tool_use for a search/read op (grouped but not yet
  // counted, since counts increment on tool_result). Fall back to the
  // initializing text so MessageResponse doesn't render a bare ⎿.
  if (displayedMessages.length === 0 && !(isTranscriptMode && prompt)) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>
    )
  }

  const {
    lookups: subagentLookups,
    inProgressToolUseIDs: collapsedInProgressIDs,
  } = buildSubagentLookups(
    progressMessages
      .filter((pm): pm is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(pm.data),
      )
      .map(pm => pm.data),
  )
  const inProgressToolUseIDs = isAgentRunning
    ? collapsedInProgressIDs
    : new Set<string>()

  const body = (
    <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {isTranscriptMode && prompt && (
            <Box marginBottom={1}>
              <AgentPromptDisplay prompt={prompt} />
            </Box>
          )}
          {displayedMessages.map((processed, index) => {
            if (processed.type === 'summary') {
              // Render summary for grouped search/read/REPL operations using shared formatting
              const summaryText = getSearchReadSummaryText(
                processed.searchCount,
                processed.readCount,
                processed.isActive,
                processed.replCount,
              )
              return (
                <Box key={processed.uuid} height={1} overflow="hidden">
                  <Text dimColor>{summaryText}</Text>
                </Box>
              )
            }
            // For the last displayed message (non-transcript mode), render a
            // compact header that appends aggregated stats on the same row —
            // matching the grouped multi-agent per-row summary. Component
            // falls back to MessageComponent internally on extraction miss.
            const isLast = index === displayedMessages.length - 1
            if (isLast && !isTranscriptMode) {
              return (
                <SingleAgentLastLineWithStats
                  key={processed.message.uuid}
                  lastProcessed={processed}
                  allProgressMessages={progressMessages}
                  tools={tools}
                  verbose={verbose}
                  subagentLookups={subagentLookups}
                  inProgressToolUseIDs={inProgressToolUseIDs}
                  suppressInlineStats={hiddenToolUseCount > 0}
                  isAgentRunning={isAgentRunning}
                />
              )
            }
            // Render original message without height=1 wrapper so null
            // content (tool not found, renderToolUseMessage returns null)
            // doesn't leave a blank line. Tool call headers are single-line
            // anyway so truncation isn't needed.
            return (
              <MessageComponent
                key={processed.message.uuid}
                message={processed.message.data.message}
                lookups={subagentLookups}
                addMargin={false}
                tools={tools}
                commands={[]}
                verbose={verbose}
                inProgressToolUseIDs={inProgressToolUseIDs}
                progressMessagesForMessage={[]}
                shouldAnimate={false}
                shouldShowDot={false}
                style="condensed"
                isTranscriptMode={false}
                isStatic={true}
              />
            )
          })}
        </SubAgentProvider>
        {hiddenToolUseCount > 0 && (
          <PlusNMoreWithStats
            allProgressMessages={progressMessages}
            isAgentRunning={isAgentRunning}
          />
        )}
      </Box>
    </MessageResponse>
  )

  // Transcript mode already renders the full prompt + transcript inline;
  // no click affordance to add. Also skip when we lack the tool-use ID.
  if (isTranscriptMode || !toolUseId) {
    return body
  }

  return (
    <ExpandableSingleAgentProgress toolUseId={toolUseId} prompt={prompt}>
      {body}
    </ExpandableSingleAgentProgress>
  )
}

/**
 * Click-to-expand wrapper for the single-agent in-progress view. When expanded,
 * prepends the agent's prompt above the existing live 3-call body so the user
 * can see what was asked without opening the full transcript (Ctrl+O).
 */
function ExpandableSingleAgentProgress({
  toolUseId,
  prompt,
  children,
}: {
  toolUseId: string
  prompt: string | undefined
  children: React.ReactNode
}): React.ReactNode {
  const expanded = useIsAgentToolUseExpanded(toolUseId)
  const toggle = useToggleAgentToolUseExpansion(toolUseId)
  if (!expanded) {
    return (
      <Box flexDirection="column" onClick={toggle}>
        {children}
      </Box>
    )
  }
  // Wrapping in MessageResponse here lets the inner body's own
  // MessageResponse collapse via MessageResponseContext, so the prompt
  // and body share a single ⎿ tree prefix.
  return (
    <MessageResponse>
      <Box flexDirection="column" onClick={toggle}>
        {prompt && (
          <Box marginBottom={1}>
            <AgentPromptDisplay prompt={prompt} />
          </Box>
        )}
        {children}
      </Box>
    </MessageResponse>
  )
}

export function renderToolUseRejectedMessage(
  _input: { description: string; prompt: string; subagent_type: string },
  {
    progressMessagesForMessage,
    tools,
    verbose,
    isTranscriptMode,
  }: {
    columns: number
    messages: Message[]
    style?: 'condensed'
    theme: ThemeName
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  // Get agentId from progress messages if available (agent was running before rejection)
  const firstData = progressMessagesForMessage[0]?.data
  const agentId =
    firstData && hasProgressMessage(firstData) ? firstData.agentId : undefined

  return (
    <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
        tools,
        verbose,
        isTranscriptMode,
        isAgentRunning: false,
      })}
      <FallbackToolUseRejectedMessage />
    </>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    progressMessagesForMessage,
    tools,
    verbose,
    isTranscriptMode,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  return (
    <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
        tools,
        verbose,
        isTranscriptMode,
        isAgentRunning: false,
      })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>
  )
}

function calculateAgentStats(
  progressMessages: ProgressMessage<Progress>[],
  output: Output | undefined,
  nowMs: number,
): {
  toolUseCount: number
  tokens: number | null
  durationMs: number | null
} {
  // Prefer authoritative totals from the completed output. Progress messages
  // aren't persisted across session save/resume, so after resume they're
  // empty — but the completed tool result carries the final totals and is
  // restored from disk. Using these totals keeps the stats correct after
  // resume and matches the "Done (…)" trailer shown elsewhere.
  if (output && output.status === 'completed') {
    return {
      toolUseCount: output.totalToolUseCount,
      tokens: output.totalTokens,
      durationMs: output.totalDurationMs,
    }
  }

  const toolUseCount = count(progressMessages, msg => {
    if (!hasProgressMessage(msg.data)) {
      return false
    }
    const message = msg.data.message
    return (
      message.type === 'user' &&
      message.message.content.some(content => content.type === 'tool_result')
    )
  })

  const tokens = calculateAgentProgressTokens(progressMessages)

  // Live elapsed time derived from the first progress message's timestamp.
  // Null when no progress messages have arrived yet (we don't know when the
  // tool use started) — the status line falls back to plain 'Initializing…'.
  const firstTimestamp = progressMessages[0]?.timestamp
  const startMs = firstTimestamp ? Date.parse(firstTimestamp) : NaN
  const durationMs = Number.isFinite(startMs)
    ? Math.max(0, nowMs - startMs)
    : null

  return { toolUseCount, tokens, durationMs }
}

/**
 * Re-renders once per second while `enabled`, returning `Date.now()`. Used to
 * drive live elapsed-time display in the grouped agent view. Torn down
 * automatically when `enabled` flips false (all agents complete).
 */
function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs])

  return now
}

/**
 * Renders the final displayed progress message (a tool_use) as a compact
 * header with aggregated stats appended on the same row:
 *
 *   Read(CLAUDE.md) · 1 tool use · 15.9k tokens · 5s
 *
 * This mirrors the per-row summary the grouped (multi-agent) view shows via
 * `AgentProgressLine`, so single- and multi-agent views stay consistent.
 *
 * The hosting `renderToolUseProgressMessage` is a plain function and can't
 * use hooks, so this component owns `useNow` / `useTheme` and is rendered
 * only for the last displayed message. Unmounts as soon as the agent
 * resolves (AssistantToolUseMessage stops calling the progress renderer).
 *
 * Falls back to the regular `<MessageComponent>` render when the tool
 * can't be identified (unknown tool, input parse failure, null/empty
 * renderToolUseMessage result) so the caller's loop stays simple.
 */
function SingleAgentLastLineWithStats({
  lastProcessed,
  allProgressMessages,
  tools,
  verbose,
  subagentLookups,
  inProgressToolUseIDs,
  suppressInlineStats = false,
  isAgentRunning = true,
}: {
  lastProcessed: Extract<ProcessedMessage, { type: 'original' }>
  allProgressMessages: ProgressMessage<Progress>[]
  tools: Tools
  verbose: boolean
  subagentLookups: ReturnType<typeof buildSubagentLookups>['lookups']
  inProgressToolUseIDs: Set<string>
  /** When true, don't append the aggregate stats on this row — caller is
   *  rendering them on the `+N more tool uses` summary line instead. */
  suppressInlineStats?: boolean
  isAgentRunning?: boolean
}): React.ReactNode {
  const [theme] = useTheme()
  const nowMs = useNow(isAgentRunning)

  const fallback = (
    <MessageComponent
      message={lastProcessed.message.data.message}
      lookups={subagentLookups}
      addMargin={false}
      tools={tools}
      commands={[]}
      verbose={verbose}
      inProgressToolUseIDs={inProgressToolUseIDs}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      style="condensed"
      isTranscriptMode={false}
      isStatic={true}
    />
  )

  // Find the last tool_use block in the assistant message's content.
  const lastMsg = lastProcessed.message.data.message
  const content =
    lastMsg.type === 'assistant' || lastMsg.type === 'user'
      ? lastMsg.message.content
      : []
  let toolUse: ToolUseBlockParam | null = null
  for (let i = (content as unknown[]).length - 1; i >= 0; i--) {
    const block = (content as unknown[])[i]
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: string }).type === 'tool_use'
    ) {
      toolUse = block as ToolUseBlockParam
      break
    }
  }
  if (!toolUse) {
    return fallback
  }

  const tool = findToolByName(tools, toolUse.name)
  if (!tool) {
    return fallback
  }

  const parsed = tool.inputSchema.safeParse(toolUse.input)
  const input = parsed.success ? parsed.data : {}
  const userFacingToolName = tool.userFacingName(
    parsed.success ? parsed.data : undefined,
  )
  if (!userFacingToolName) {
    return fallback
  }

  let renderedToolUseMessage: React.ReactNode
  try {
    renderedToolUseMessage = tool.renderToolUseMessage(input, {
      theme,
      verbose,
      commands: [],
    })
  } catch {
    return fallback
  }
  if (renderedToolUseMessage === null) {
    return fallback
  }

  const stats = calculateAgentStats(allProgressMessages, undefined, nowMs)
  const counterParts: string[] = []
  if (stats.toolUseCount > 0) {
    counterParts.push(
      stats.toolUseCount === 1
        ? '1 tool use'
        : `${stats.toolUseCount} tool uses`,
    )
  }
  if (stats.tokens !== null && stats.tokens > 0) {
    counterParts.push(`${formatNumber(stats.tokens)} tokens`)
  }
  if (stats.durationMs !== null) {
    counterParts.push(formatDuration(stats.durationMs))
  }

  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Box flexShrink={0}>
        <Text bold>{userFacingToolName}</Text>
      </Box>
      {renderedToolUseMessage !== '' && (
        <Box flexWrap="nowrap">
          <Text>({renderedToolUseMessage})</Text>
        </Box>
      )}
      {!suppressInlineStats && counterParts.length > 0 && (
        <Text dimColor> · {counterParts.join(' · ')}</Text>
      )}
    </Box>
  )
}

/**
 * Summary row rendered below the last few progress messages when some tool
 * uses are hidden. Replaces the plain "+N more tool uses" text with the
 * aggregate stats (tool uses, tokens, duration) and the ctrl+o affordance —
 * avoids crowding the last invocation row with stats that aren't its own.
 */
function PlusNMoreWithStats({
  allProgressMessages,
  isAgentRunning = true,
}: {
  allProgressMessages: ProgressMessage<Progress>[]
  isAgentRunning?: boolean
}): React.ReactNode {
  const nowMs = useNow(isAgentRunning)
  const stats = calculateAgentStats(allProgressMessages, undefined, nowMs)
  const parts: string[] = []
  if (stats.toolUseCount > 0) {
    parts.push(
      stats.toolUseCount === 1
        ? '1 tool use'
        : `${stats.toolUseCount} tool uses`,
    )
  }
  if (stats.tokens !== null && stats.tokens > 0) {
    parts.push(`${formatNumber(stats.tokens)} tokens`)
  }
  if (stats.durationMs !== null) {
    parts.push(formatDuration(stats.durationMs))
  }
  return (
    <Text dimColor>
      {parts.length > 0 ? `${parts.join(' · ')} ` : ''}
      <CtrlOToExpand />
    </Text>
  )
}

type GroupedAgentToolUse = {
  param: ToolUseBlockParam
  isResolved: boolean
  isError: boolean
  isInProgress: boolean
  progressMessages: ProgressMessage<Progress>[]
  result?: {
    param: ToolResultBlockParam
    output: Output
  }
}

function GroupedAgentToolUseView({
  toolUses,
  shouldAnimate,
  tools,
}: {
  toolUses: GroupedAgentToolUse[]
  shouldAnimate: boolean
  tools: Tools
}): React.ReactNode | null {
  const mainModel = getMainLoopModel()
  const activeAgents = useAppStateMaybeOutsideOfProvider(
    state => state.agentDefinitions.activeAgents,
  )
  const anyUnresolved = toolUses.some(t => !t.isResolved)
  const nowMs = useNow(anyUnresolved)

  // Calculate stats for each agent
  const agentStats = toolUses.map(
    ({ param, isResolved, isError, progressMessages, result }) => {
      const stats = calculateAgentStats(progressMessages, result?.output, nowMs)
      const lastToolInfo = extractLastToolInfo(progressMessages, tools)
      const parsedInput = inputSchema().safeParse(param.input)

      // teammate_spawned is not part of the exported Output type (cast through unknown
      // for dead code elimination), so check via string comparison on the raw value
      const isTeammateSpawn =
        (result?.output?.status as string) === 'teammate_spawned'

      // For teammate spawns, show @name with type in parens and description as status
      let agentType: string
      let description: string | undefined
      let color: keyof Theme | undefined
      let descriptionColor: keyof Theme | undefined
      let taskDescription: string | undefined
      // Widen the inferred schema type: `name` is omit()ed when the agent-
      // swarms gate is off, but at runtime the field can still be present on
      // teammate-spawn inputs. Cast to reveal the optional field.
      const widenedInput = parsedInput.success
        ? (parsedInput.data as typeof parsedInput.data & { name?: string })
        : undefined
      if (isTeammateSpawn && widenedInput?.name) {
        agentType = `@${widenedInput.name}`
        const subagentType = widenedInput.subagent_type
        description = isCustomSubagentType(subagentType)
          ? subagentType
          : undefined
        taskDescription = widenedInput.description
        // Use the custom agent definition's color on the type, not the name
        descriptionColor = isCustomSubagentType(subagentType)
          ? (getAgentColor(subagentType) as keyof Theme | undefined)
          : undefined
      } else {
        agentType = parsedInput.success
          ? userFacingName(parsedInput.data)
          : 'Agent'
        description = parsedInput.success
          ? parsedInput.data.description
          : undefined
        color = parsedInput.success
          ? userFacingNameBackgroundColor(parsedInput.data)
          : undefined
        taskDescription = undefined
      }

      // Check if this was launched as a background agent OR backgrounded mid-execution
      const launchedAsAsync =
        parsedInput.success &&
        'run_in_background' in parsedInput.data &&
        parsedInput.data.run_in_background === true
      const outputStatus = (result?.output as { status?: string } | undefined)
        ?.status
      const backgroundedMidExecution = outputStatus === 'async_launched'
      const isAsync =
        launchedAsAsync || backgroundedMidExecution || isTeammateSpawn

      const name = widenedInput?.name

      // Resolve effective model; show tag only when it differs from the main
      // loop model. Matches single-agent behavior in renderAgentToolUseTag.
      const subagentType = parsedInput.success
        ? parsedInput.data.subagent_type
        : undefined
      const agentDefinitionModel = subagentType
        ? activeAgents?.find(a => a.agentType === subagentType)?.model
        : undefined
      const toolSpecifiedModel = parsedInput.success
        ? parsedInput.data.model
        : undefined
      const resolvedModel = getAgentModel(
        agentDefinitionModel,
        mainModel,
        toolSpecifiedModel,
      )
      const effectiveModel = resolvedModel !== mainModel ? resolvedModel : null

      return {
        id: param.id,
        agentType,
        description,
        toolUseCount: stats.toolUseCount,
        tokens: stats.tokens,
        durationMs: stats.durationMs,
        effectiveModel,
        isResolved,
        isError,
        isAsync,
        color,
        descriptionColor,
        lastToolInfo,
        taskDescription,
        name,
      }
    },
  )

  const anyError = toolUses.some(t => t.isError)
  const allComplete = !anyUnresolved

  // Check if all agents are the same type
  const allSameType =
    agentStats.length > 0 &&
    agentStats.every(stat => stat.agentType === agentStats[0]?.agentType)
  const commonType =
    allSameType && agentStats[0]?.agentType !== 'Agent'
      ? agentStats[0]?.agentType
      : null

  // Check if all resolved agents are async (background)
  const allAsync = agentStats.every(stat => stat.isAsync)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <ToolUseLoader
          shouldAnimate={shouldAnimate && anyUnresolved}
          isUnresolved={anyUnresolved}
          isError={anyError}
        />
        <Text>
          {allComplete ? (
            allAsync ? (
              <>
                <Text bold>{toolUses.length}</Text> background agents launched{' '}
                <Text dimColor>
                  <KeyboardShortcutHint shortcut="↓" action="manage" parens />
                </Text>
              </>
            ) : (
              <>
                <Text bold>{toolUses.length}</Text>{' '}
                {commonType ? `${commonType} agents` : 'agents'} finished
              </>
            )
          ) : (
            <>
              Running <Text bold>{toolUses.length}</Text>{' '}
              {commonType ? `${commonType} agents` : 'agents'}…
            </>
          )}{' '}
        </Text>
        {!allAsync && <CtrlOToExpand />}
      </Box>
      {agentStats.map((stat, index) => {
        const toolUse = toolUses[index]!
        const firstData = toolUse.progressMessages[0]?.data
        const rowPrompt =
          firstData && hasProgressMessage(firstData)
            ? firstData.prompt
            : undefined
        // Completed row's final response text blocks — only present once the
        // agent has fully resolved. Grouped view reuses AgentResponseDisplay
        // inside AgentRowWithExpand to mirror the single-agent expanded view.
        const rowContent =
          toolUse.result?.output && toolUse.result.output.status === 'completed'
            ? toolUse.result.output.content
            : undefined
        const progressLine = (
          <AgentProgressLine
            agentType={stat.agentType}
            description={stat.description}
            descriptionColor={stat.descriptionColor}
            taskDescription={stat.taskDescription}
            toolUseCount={stat.toolUseCount}
            tokens={stat.tokens}
            durationMs={stat.durationMs}
            effectiveModel={stat.effectiveModel}
            color={stat.color}
            isLast={index === agentStats.length - 1}
            isResolved={stat.isResolved}
            isError={stat.isError}
            isAsync={stat.isAsync}
            shouldAnimate={shouldAnimate}
            lastToolInfo={stat.lastToolInfo}
            // Always show full AgentType(description) format to match the
            // single-agent header, even when all grouped agents share a type.
            hideType={false}
            name={stat.name}
          />
        )
        return (
          <AgentRowWithExpand
            key={stat.id}
            toolUseId={stat.id}
            prompt={rowPrompt}
            content={rowContent}
            progressMessages={toolUse.progressMessages}
            tools={tools}
            isBackgrounded={stat.isAsync && stat.isResolved}
          >
            {progressLine}
          </AgentRowWithExpand>
        )
      })}
    </Box>
  )
}

/**
 * Per-row wrapper for the grouped multi-agent view. Owns its own expansion
 * subscription so a click on one row re-renders just that row, not its
 * siblings. Backgrounded rows are non-clickable (the only meaningful action
 * is foregrounding via ↓, not expanding in place).
 */
function AgentRowWithExpand({
  toolUseId,
  prompt,
  content,
  progressMessages,
  tools,
  isBackgrounded,
  children,
}: {
  toolUseId: string
  prompt: string | undefined
  content: { type: string; text: string }[] | undefined
  progressMessages: ProgressMessage<Progress>[]
  tools: Tools
  isBackgrounded: boolean
  children: React.ReactNode
}): React.ReactNode {
  const expanded = useIsAgentToolUseExpanded(toolUseId)
  const toggle = useToggleAgentToolUseExpansion(toolUseId)

  if (isBackgrounded) {
    return <Box flexDirection="column">{children}</Box>
  }

  if (!expanded) {
    return (
      <Box flexDirection="column" onClick={toggle}>
        {children}
      </Box>
    )
  }

  // Render the prompt and last 3 tool calls below the title/status row,
  // indented to align under the row's content.
  const processed = processProgressMessages(progressMessages, tools, true)
  const displayedMessages = processed.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)
  const {
    lookups: subagentLookups,
    inProgressToolUseIDs: collapsedInProgressIDs,
  } = buildSubagentLookups(
    progressMessages
      .filter((pm): pm is ProgressMessage<AgentToolProgress> =>
        hasProgressMessage(pm.data),
      )
      .map(pm => pm.data),
  )

  return (
    <Box flexDirection="column" onClick={toggle}>
      {children}
      <Box paddingLeft={6} flexDirection="column">
        {prompt && (
          <Box marginBottom={1}>
            <AgentPromptDisplay prompt={prompt} />
          </Box>
        )}
        {displayedMessages.length > 0 && (
          <SubAgentProvider>
            {displayedMessages.map(p => {
              if (p.type === 'summary') {
                const summaryText = getSearchReadSummaryText(
                  p.searchCount,
                  p.readCount,
                  p.isActive,
                  p.replCount,
                )
                return (
                  <Box key={p.uuid} height={1} overflow="hidden">
                    <Text dimColor>{summaryText}</Text>
                  </Box>
                )
              }
              return (
                <MessageComponent
                  key={p.message.uuid}
                  message={p.message.data.message}
                  lookups={subagentLookups}
                  addMargin={false}
                  tools={tools}
                  commands={[]}
                  verbose={false}
                  inProgressToolUseIDs={collapsedInProgressIDs}
                  progressMessagesForMessage={[]}
                  shouldAnimate={false}
                  shouldShowDot={false}
                  style="condensed"
                  isTranscriptMode={false}
                  isStatic={true}
                />
              )
            })}
          </SubAgentProvider>
        )}
        {content && content.length > 0 && (
          <Box marginTop={1} marginBottom={1}>
            <AgentResponseDisplay content={content} />
          </Box>
        )}
      </Box>
    </Box>
  )
}

export function renderGroupedAgentToolUse(
  toolUses: GroupedAgentToolUse[],
  options: {
    shouldAnimate: boolean
    tools: Tools
  },
): React.ReactNode | null {
  return (
    <GroupedAgentToolUseView
      toolUses={toolUses}
      shouldAnimate={options.shouldAnimate}
      tools={options.tools}
    />
  )
}

export function userFacingName(
  input:
    | Partial<{
        description: string
        prompt: string
        subagent_type: string
        name: string
        team_name: string
      }>
    | undefined,
): string {
  if (
    input?.subagent_type &&
    input.subagent_type !== GENERAL_PURPOSE_AGENT.agentType
  ) {
    // Display "worker" agents as "Agent" for cleaner UI
    if (input.subagent_type === 'worker') {
      return 'Agent'
    }
    return input.subagent_type
  }
  return 'Agent'
}

export function userFacingNameBackgroundColor(
  input:
    | Partial<{ description: string; prompt: string; subagent_type: string }>
    | undefined,
): keyof Theme | undefined {
  if (!input?.subagent_type) {
    return undefined
  }

  // Get the color for this agent
  return getAgentColor(input.subagent_type) as keyof Theme | undefined
}

export function extractLastToolInfo(
  progressMessages: ProgressMessage<Progress>[],
  tools: Tools,
): string | null {
  // Build tool_use lookup from all progress messages (needed for reverse iteration)
  const toolUseByID = new Map<string, ToolUseBlockParam>()
  for (const pm of progressMessages) {
    if (!hasProgressMessage(pm.data)) {
      continue
    }
    if (pm.data.message.type === 'assistant') {
      for (const c of pm.data.message.message.content) {
        if (c.type === 'tool_use') {
          toolUseByID.set(c.id, c as ToolUseBlockParam)
        }
      }
    }
  }

  // Count trailing consecutive search/read operations from the end
  let searchCount = 0
  let readCount = 0
  for (let i = progressMessages.length - 1; i >= 0; i--) {
    const msg = progressMessages[i]!
    if (!hasProgressMessage(msg.data)) {
      continue
    }
    const info = getSearchOrReadInfo(msg, tools, toolUseByID)
    if (info && (info.isSearch || info.isRead)) {
      // Only count tool_result messages to avoid double counting
      if (msg.data.message.type === 'user') {
        if (info.isSearch) {
          searchCount++
        } else if (info.isRead) {
          readCount++
        }
      }
    } else {
      break
    }
  }

  if (searchCount + readCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true)
  }

  // Find the last tool_result message
  const lastToolResult = progressMessages.findLast(
    (msg): msg is ProgressMessage<AgentToolProgress> => {
      if (!hasProgressMessage(msg.data)) {
        return false
      }
      const message = msg.data.message
      return (
        message.type === 'user' &&
        message.message.content.some(c => c.type === 'tool_result')
      )
    },
  )

  if (lastToolResult?.data.message.type === 'user') {
    const toolResultBlock = lastToolResult.data.message.message.content.find(
      c => c.type === 'tool_result',
    )

    if (toolResultBlock?.type === 'tool_result') {
      // Look up the corresponding tool_use — already indexed above
      const toolUseBlock = toolUseByID.get(toolResultBlock.tool_use_id)

      if (toolUseBlock) {
        const tool = findToolByName(tools, toolUseBlock.name)
        if (!tool) {
          return toolUseBlock.name // Fallback to raw name
        }

        const input = toolUseBlock.input as Record<string, unknown>
        const parsedInput = tool.inputSchema.safeParse(input)

        // Get user-facing tool name
        const userFacingToolName = tool.userFacingName(
          parsedInput.success ? parsedInput.data : undefined,
        )

        // Try to get summary from the tool itself
        if (tool.getToolUseSummary) {
          const summary = tool.getToolUseSummary(
            parsedInput.success ? parsedInput.data : undefined,
          )
          if (summary) {
            return `${userFacingToolName}: ${summary}`
          }
        }

        // Default: just show user-facing tool name
        return userFacingToolName
      }
    }
  }

  return null
}

function isCustomSubagentType(
  subagentType: string | undefined,
): subagentType is string {
  return (
    !!subagentType &&
    subagentType !== GENERAL_PURPOSE_AGENT.agentType &&
    subagentType !== 'worker'
  )
}
