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
import { buildSubagentLookups, EMPTY_LOOKUPS } from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { renderRunCodeResultText, type RunCodeOutput } from './RunCodeTool.js'

const MAX_PROGRESS_MESSAGES_TO_SHOW = 5

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

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<ToolProgressData>[],
  {
    tools,
    verbose,
  }: {
    tools: Tools
    verbose: boolean
  },
): React.ReactNode {
  const nested = filterRunCodeProgress(progressMessages)
  if (nested.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running script…</Text>
      </MessageResponse>
    )
  }
  const displayed = verbose
    ? nested
    : nested.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)
  const hidden = nested.length - displayed.length
  const { inProgressToolUseIDs } = buildSubagentLookups(
    nested.map(pm => pm.data),
  )
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {displayed.map(progressMessage => (
            <Box key={progressMessage.uuid} height={1} overflow="hidden">
              <MessageComponent
                message={progressMessage.data.message}
                lookups={EMPTY_LOOKUPS}
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
  const parts: string[] = []
  const calls = output.segments.length
  if (calls > 0) {
    parts.push(`${calls} ${plural(calls, 'call')}`)
  }
  const failed = output.segments.filter(s => !s.ok).length
  if (failed > 0) {
    parts.push(`${failed} failed`)
  }
  if (output.logs.length > 0) {
    parts.push(`${output.logs.split('\n').length} logged lines`)
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
      })}
      <FallbackToolUseErrorMessage
        result={result as never}
        verbose={options.verbose}
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
