import type { DomainToolResultBlockParam } from '../../types/domain.js'
import * as React from 'react'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { truncateCommandForDisplay } from '../../components/shell/CommandPreview.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js'
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js'
import { Box, Text } from '../../ink.js'
import type { Tool } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { PowerShellProgress } from '../../types/tools.js'
import { BACKGROUND_TASK_NUDGE } from '../../utils/task/backgroundNudge.js'
import type { ThemeName } from '../../utils/theme.js'
import type { Out, PowerShellToolInput } from './PowerShellTool.js'

export function renderToolUseMessage(
  input: Partial<PowerShellToolInput>,
  { verbose, theme: _theme }: { verbose: boolean; theme: ThemeName },
): React.ReactNode {
  const { command } = input
  if (!command) {
    return null
  }

  if (!verbose) {
    const preview = truncateCommandForDisplay(command)
    if (preview !== null) {
      return <Text>{preview}</Text>
    }
  }

  return command
}

export function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<PowerShellProgress>[],
  {
    verbose,
    tools: _tools,
    terminalSize: _terminalSize,
    inProgressToolCallCount: _inProgressToolCallCount,
  }: {
    tools: Tool[]
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
  },
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1)

  if (!lastProgress || !lastProgress.data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running…</Text>
      </MessageResponse>
    )
  }

  const data = lastProgress.data

  return (
    <ShellProgressMessage
      fullOutput={data.fullOutput}
      output={data.output}
      elapsedTimeSeconds={data.elapsedTimeSeconds}
      totalLines={data.totalLines}
      totalBytes={data.totalBytes}
      timeoutMs={data.timeoutMs}
      taskId={data.taskId}
      verbose={verbose}
    />
  )
}

export function renderToolUseQueuedMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Waiting…</Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  content: Out,
  progressMessagesForMessage: ProgressMessage<PowerShellProgress>[],
  {
    verbose,
    theme: _theme,
    tools: _tools,
    style: _style,
  }: {
    verbose: boolean
    theme: ThemeName
    tools: Tool[]
    style?: 'condensed'
  },
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1)
  const timeoutMs = lastProgress?.data?.timeoutMs
  const {
    stdout,
    stderr,
    interrupted,
    returnCodeInterpretation,
    isImage,
    backgroundTaskId,
  } = content

  if (isImage) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>[Image data detected and sent to Claude]</Text>
      </MessageResponse>
    )
  }

  return (
    <Box flexDirection="column">
      {stdout !== '' ? <OutputLine content={stdout} verbose={verbose} /> : null}
      {stderr.trim() !== '' ? (
        <OutputLine content={stderr} verbose={verbose} isError />
      ) : null}
      {stdout === '' && stderr.trim() === '' ? (
        backgroundTaskId ? (
          // The model's own nudge from the tool_result, shown verbatim so
          // the user sees exactly what the model was told.
          <MessageResponse>
            <Box flexDirection="column">
              <Text dimColor>
                Running in the background{' '}
                <KeyboardShortcutHint shortcut="↓" action="manage" parens />
              </Text>
              <Text dimColor>{BACKGROUND_TASK_NUDGE}</Text>
            </Box>
          </MessageResponse>
        ) : (
          <MessageResponse height={1}>
            <Text dimColor>
              {interrupted
                ? 'Interrupted'
                : returnCodeInterpretation || '(No output)'}
            </Text>
          </MessageResponse>
        )
      ) : null}
      {timeoutMs ? (
        <MessageResponse>
          <ShellTimeDisplay timeoutMs={timeoutMs} />
        </MessageResponse>
      ) : null}
    </Box>
  )
}

export function renderToolUseErrorMessage(
  result: DomainToolResultBlockParam['content'],
  {
    verbose,
    progressMessagesForMessage: _progressMessagesForMessage,
    tools: _tools,
  }: {
    verbose: boolean
    progressMessagesForMessage: ProgressMessage<PowerShellProgress>[]
    tools: Tool[]
  },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
