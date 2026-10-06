// Rendering for the RunCode code-mode runner. The live view replays the
// child tool_use / tool_result messages forwarded as runcode_progress,
// rendered through the generic Message component (same pattern as
// SkillTool/AgentTool UIs), so nested calls look exactly like direct tool
// rows. Raw shell progress forwarded from inner tools lacks a message and
// is skipped, as in the AgentTool UI.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import { SubAgentProvider } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Byline } from '../../components/design-system/Byline.js'
import type { ProgressMessage } from '../../types/message.js'
import type { RunCodeProgress, ToolProgressData } from '../../types/tools.js'
import { buildSubagentLookups } from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { renderRunCodeResultText, type RunCodeOutput } from './RunCodeTool.js'

const MAX_PROGRESS_MESSAGES_TO_SHOW = 5
/**
 * Collapsed cap for a script error: the throwing call's one-line headline
 * plus the first line of its message. The MCP `### Error` framing strips the
 * payload to its echoed input, which the reader has usually already seen.
 */
const ERROR_HEADLINE_LINES = 2

function hasProgressMessage(data: ToolProgressData): data is RunCodeProgress {
  if (!('message' in data)) return false
  const msg = (data as RunCodeProgress).message
  return msg != null && typeof msg === 'object' && 'type' in msg
}

function filterRunCodeProgress(
  progressMessages: ProgressMessage<ToolProgressData>[],
): ProgressMessage<RunCodeProgress>[] {
  return progressMessages.filter(
    (msg): msg is ProgressMessage<RunCodeProgress> =>
      msg.data != null && hasProgressMessage(msg.data),
  )
}

function erroredToolUseIDsOf(
  nested: ProgressMessage<RunCodeProgress>[],
): Set<string> {
  const errored = new Set<string>()
  for (const pm of nested) {
    const msg = pm.data.message
    if (msg.type !== 'user') continue
    const content = Array.isArray(msg.message.content)
      ? msg.message.content
      : []
    for (const block of content) {
      if (
        block.type === 'tool_result' &&
        (block as { is_error?: boolean }).is_error === true
      ) {
        errored.add(block.tool_use_id)
      }
    }
  }
  return errored
}

function countToolUses(nested: ProgressMessage<RunCodeProgress>[]): number {
  let calls = 0
  for (const pm of nested) {
    const msg = pm.data.message
    if (msg.type !== 'assistant') continue
    for (const content of msg.message.content) {
      if (content.type === 'tool_use') calls++
    }
  }
  return calls
}

/** True for the row carrying a failed call's tool_result. */
function isErroredRow(
  pm: ProgressMessage<RunCodeProgress>,
  errored: Set<string>,
): boolean {
  const msg = pm.data.message
  if (msg.type !== 'user' || errored.size === 0) return false
  const content = Array.isArray(msg.message.content) ? msg.message.content : []
  return content.some(
    block => block.type === 'tool_result' && errored.has(block.tool_use_id),
  )
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<ToolProgressData>[],
  {
    tools,
    verbose,
    running = true,
  }: {
    tools: Tools
    verbose: boolean
    /** False when replaying history under an already-failed run. */
    running?: boolean
  },
): React.ReactNode {
  const nested = filterRunCodeProgress(progressMessages)
  if (nested.length === 0) {
    if (!running) return null
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running script…</Text>
      </MessageResponse>
    )
  }
  const errored = erroredToolUseIDsOf(nested)
  // A failed call breaks out of the tail trim: the row that explains the
  // run must never scroll out of the collapsed view.
  const shown = verbose
    ? new Set(nested)
    : new Set([
        ...nested.filter(pm => isErroredRow(pm, errored)),
        ...nested
          .filter(pm => !isErroredRow(pm, errored))
          .slice(-MAX_PROGRESS_MESSAGES_TO_SHOW),
      ])
  const displayed = nested.filter(pm => shown.has(pm))
  const hidden = nested.length - displayed.length
  const { lookups, inProgressToolUseIDs } = buildSubagentLookups(
    nested.map(pm => pm.data),
  )
  const calls = countToolUses(nested)
  const failed = errored.size
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <Byline>
            <Text dimColor>
              {running ? 'Running script' : 'Script stopped'}
            </Text>
            {calls > 0 && (
              <Text dimColor>{`${calls} ${plural(calls, 'call')}`}</Text>
            )}
            {failed > 0 && (
              <Text color="error">{`${failed} ${plural(failed, 'call')} failed`}</Text>
            )}
          </Byline>
        </Text>
        <SubAgentProvider>
          {displayed.map(progressMessage => (
            <Box
              key={progressMessage.uuid}
              height={verbose ? undefined : 1}
              overflow="hidden"
            >
              <MessageComponent
                message={progressMessage.data.message}
                lookups={{ ...lookups, erroredToolUseIDs: errored }}
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
            </Box>
          ))}
        </SubAgentProvider>
        {hidden > 0 && (
          <Text dimColor>
            +{hidden} more tool {plural(hidden, 'use')}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: RunCodeOutput,
): React.ReactNode {
  const parts: React.ReactNode[] = []
  const calls = output.segments.length
  if (calls > 0) {
    parts.push(
      <Text key="calls" dimColor>{`${calls} ${plural(calls, 'call')}`}</Text>,
    )
  }
  const failed = output.segments.filter(s => !s.ok).length
  if (failed > 0) {
    parts.push(<Text key="failed" color="error">{`${failed} failed`}</Text>)
  }
  if (output.logs.length > 0) {
    parts.push(
      <Text
        key="logs"
        dimColor
      >{`${output.logs.split('\n').length} logged lines`}</Text>,
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        <Byline>{parts.length > 0 ? parts : ['no tool calls']}</Byline>
      </Text>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: unknown,
  options: {
    progressMessagesForMessage: ProgressMessage<ToolProgressData>[]
    tools: Tools
    verbose: boolean
  },
): React.ReactNode {
  return (
    <>
      {renderToolUseProgressMessage(options.progressMessagesForMessage, {
        tools: options.tools,
        verbose: options.verbose,
        running: false,
      })}
      <FallbackToolUseErrorMessage
        result={result as never}
        verbose={options.verbose}
        maxLines={options.verbose ? undefined : ERROR_HEADLINE_LINES}
      />
    </>
  )
}

export function isResultTruncated(output: RunCodeOutput): boolean {
  return isOutputLineTruncated(renderRunCodeResultText(output))
}

export function extractSearchText(output: RunCodeOutput): string {
  return renderRunCodeResultText(output)
}
