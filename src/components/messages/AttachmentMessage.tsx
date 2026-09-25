// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import type { Attachment } from 'src/utils/attachments.js'
import {
  isQueuedTaskNotification,
  rendersNoSummaryLine,
  type AttachmentWithoutSummaryLine,
} from './attachmentVisibility.js'
import { getDisplayPath } from 'src/utils/file.js'
import { formatFileSize } from 'src/utils/format.js'
import { MessageResponse } from '../MessageResponse.js'
import { basename, sep } from 'path'
import { UserTextMessage } from './UserTextMessage.js'
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js'
import {
  getAttachmentSystemReminderBodies,
  getContentText,
} from 'src/utils/messages.js'
import { InjectedContextMessage } from './InjectedContextMessage.js'
import type { Theme } from 'src/utils/theme.js'
import { UserImageMessage } from './UserImageMessage.js'
import { plural } from '../../utils/stringUtils.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { FilePathLink } from '../FilePathLink.js'
import { useSelectedMessageBg } from '../messageActions.js'

type Props = {
  addMargin: boolean
  attachment: Attachment
  verbose: boolean
  isTranscriptMode?: boolean
  showInjectedContext: boolean
}

export function AttachmentMessage(props: Props): React.ReactNode {
  const { attachment, addMargin, verbose, showInjectedContext } = props
  const content = <AttachmentMessageContent {...props} />

  const reminders =
    showInjectedContext && !isQueuedTaskNotification(attachment)
      ? getAttachmentSystemReminderBodies(attachment)
      : []
  if (reminders.length === 0) {
    return content
  }

  // An attachment that renders no summary line has no line of its own, so the
  // reminder row owns the leading margin; otherwise it sits under one.
  const isOnlyRow = rendersNoSummaryLine(attachment)

  return (
    <Box flexDirection="column">
      {content}
      <InjectedContextMessage
        addMargin={addMargin && isOnlyRow}
        label={`System reminder · ${attachment.type}`}
        content={reminders.join('\n\n')}
        verbose={verbose}
      />
    </Box>
  )
}

function AttachmentMessageContent({
  attachment,
  addMargin,
  verbose,
  isTranscriptMode,
  showInjectedContext,
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg()
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (attachment.type) {
    case 'directory':
      return (
        <Line>
          Listed directory <Text bold>{attachment.displayPath + sep}</Text>
        </Line>
      )
    case 'file':
    case 'already_read_file':
      if (attachment.content.type === 'notebook') {
        return (
          <Line>
            Read <Text bold>{attachment.displayPath}</Text> (
            {attachment.content.file.cells.length} cells)
          </Line>
        )
      }
      if (attachment.content.type === 'file_unchanged') {
        return (
          <Line>
            Read <Text bold>{attachment.displayPath}</Text> (unchanged)
          </Line>
        )
      }
      return (
        <Line>
          Read <Text bold>{attachment.displayPath}</Text> (
          {attachment.content.type === 'text'
            ? `${attachment.content.file.numLines}${attachment.truncated ? '+' : ''} lines`
            : formatFileSize(attachment.content.file.originalSize)}
          )
        </Line>
      )
    case 'compact_file_reference':
      return (
        <Line>
          Referenced file <Text bold>{attachment.displayPath}</Text>
        </Line>
      )
    case 'pdf_reference':
      return (
        <Line>
          Referenced PDF <Text bold>{attachment.displayPath}</Text> (
          {attachment.pageCount} pages)
        </Line>
      )
    case 'selected_lines_in_ide':
      return (
        <Line>
          ⧉ Selected{' '}
          <Text bold>{attachment.lineEnd - attachment.lineStart + 1}</Text>{' '}
          lines from <Text bold>{attachment.displayPath}</Text> in{' '}
          {attachment.ideName}
        </Line>
      )
    case 'nested_memory':
      return (
        <Line>
          Loaded <Text bold>{attachment.displayPath}</Text>
        </Line>
      )
    case 'relevant_memories':
      // Usually absorbed into a CollapsedReadSearchGroup (collapseReadSearch.ts)
      // so this only renders when the preceding tool was non-collapsible (Edit,
      // Write) and no group was open. Match CollapsedReadSearchContent's style:
      // 2-space gutter, dim text, count only — filenames/content in ctrl+o.
      return (
        <Box
          flexDirection="column"
          marginTop={addMargin ? 1 : 0}
          backgroundColor={bg}
        >
          <Box flexDirection="row">
            <Box minWidth={2} />
            <Text dimColor>
              Recalled <Text bold>{attachment.memories.length}</Text>{' '}
              {attachment.memories.length === 1 ? 'memory' : 'memories'}
              {!isTranscriptMode && (
                <>
                  {' '}
                  <CtrlOToExpand />
                </>
              )}
            </Text>
          </Box>
          {(verbose || isTranscriptMode) &&
            attachment.memories.map(m => (
              <Box key={m.path} flexDirection="column">
                <MessageResponse>
                  <Text dimColor>
                    <FilePathLink filePath={m.path}>
                      {basename(m.path)}
                    </FilePathLink>
                  </Text>
                </MessageResponse>
                {isTranscriptMode && (
                  <Box paddingLeft={5}>
                    <Text>
                      <Ansi>{m.content}</Ansi>
                    </Text>
                  </Box>
                )}
              </Box>
            ))}
        </Box>
      )
    case 'dynamic_skill': {
      const skillCount = attachment.skillNames.length
      return (
        <Line>
          Loaded{' '}
          <Text bold>
            {skillCount} {plural(skillCount, 'skill')}
          </Text>{' '}
          from <Text bold>{attachment.displayPath}</Text>
        </Line>
      )
    }
    case 'skill_listing': {
      if (attachment.isInitial) {
        return null
      }
      return (
        <Line>
          <Text bold>{attachment.skillCount}</Text>{' '}
          {plural(attachment.skillCount, 'skill')} available
        </Line>
      )
    }
    case 'agent_listing_delta': {
      if (attachment.isInitial || attachment.addedTypes.length === 0) {
        return null
      }
      const count = attachment.addedTypes.length
      return (
        <Line>
          <Text bold>{count}</Text> agent {plural(count, 'type')} available
        </Line>
      )
    }
    case 'queued_command': {
      const text =
        typeof attachment.prompt === 'string'
          ? attachment.prompt
          : getContentText(attachment.prompt) || ''
      const hasImages =
        attachment.imagePasteIds && attachment.imagePasteIds.length > 0
      return (
        <Box flexDirection="column">
          <UserTextMessage
            addMargin={addMargin}
            param={{ text, type: 'text' }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
            showInjectedContext={showInjectedContext}
            isMeta={attachment.isMeta}
          />
          {hasImages &&
            attachment.imagePasteIds?.map(id => (
              <UserImageMessage key={id} imageId={id} />
            ))}
        </Box>
      )
    }
    case 'plan_file_reference':
      return (
        <Line>
          Plan file referenced ({getDisplayPath(attachment.planFilePath)})
        </Line>
      )
    case 'invoked_skills': {
      if (attachment.skills.length === 0) {
        return null
      }
      const skillNames = attachment.skills.map(s => s.name).join(', ')
      return <Line>Skills restored ({skillNames})</Line>
    }
    case 'diagnostics':
      return <DiagnosticsDisplay attachment={attachment} verbose={verbose} />
    case 'mcp_resource':
      return (
        <Line>
          Read MCP resource <Text bold>{attachment.name}</Text> from{' '}
          {attachment.server}
        </Line>
      )
    case 'command_permissions':
      // The skill success message is rendered by SkillTool's renderToolResultMessage,
      // so we don't render anything here to avoid duplicate messages.
      return null
    case 'async_hook_response': {
      // SessionStart hook completions are only shown in verbose mode
      if (attachment.hookEvent === 'SessionStart' && !verbose) {
        return null
      }
      // Generally hide async hook completion messages unless in verbose mode
      if (!verbose && !isTranscriptMode) {
        return null
      }
      return (
        <Line>
          Async hook <Text bold>{attachment.hookEvent}</Text> completed
        </Line>
      )
    }
    case 'hook_blocking_error': {
      // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
      if (
        attachment.hookEvent === 'Stop' ||
        attachment.hookEvent === 'SubagentStop'
      ) {
        return null
      }
      // Show stderr to the user so they can understand why the hook blocked
      const stderr = attachment.blockingError.blockingError.trim()
      return (
        <>
          <Line color="error">
            {attachment.hookName} hook returned blocking error
          </Line>
          {stderr ? <Line color="error">{stderr}</Line> : null}
        </>
      )
    }
    case 'hook_non_blocking_error': {
      // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
      if (
        attachment.hookEvent === 'Stop' ||
        attachment.hookEvent === 'SubagentStop'
      ) {
        return null
      }
      // Full hook output is logged to debug log via hookEvents.ts
      return <Line color="error">{attachment.hookName} hook error</Line>
    }
    case 'hook_error_during_execution':
      // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
      if (
        attachment.hookEvent === 'Stop' ||
        attachment.hookEvent === 'SubagentStop'
      ) {
        return null
      }
      // Full hook output is logged to debug log via hookEvents.ts
      return <Line>{attachment.hookName} hook warning</Line>
    case 'hook_success':
      // Full hook output is logged to debug log via hookEvents.ts
      return null
    case 'hook_stopped_continuation':
      // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
      if (
        attachment.hookEvent === 'Stop' ||
        attachment.hookEvent === 'SubagentStop'
      ) {
        return null
      }
      return (
        <Line color="warning">
          {attachment.hookName} hook stopped continuation: {attachment.message}
        </Line>
      )
    case 'hook_system_message':
      return (
        <Line>
          {attachment.hookName} says: {attachment.content}
        </Line>
      )
    case 'hook_permission_decision': {
      const action = attachment.decision === 'allow' ? 'Allowed' : 'Denied'
      return (
        <Line>
          {action} by <Text bold>{attachment.hookEvent}</Text> hook
        </Line>
      )
    }
    case 'task_status':
      return <TaskStatusMessage attachment={attachment} />
    default:
      // Exhaustiveness: every type reaching here must be in
      // TYPES_WITHOUT_SUMMARY_LINE. If TS errors, a new Attachment type was
      // added without a case above AND without an entry there — decide: render
      // something (add a case) or render no line of its own (add to the array).
      // Messages.tsx pre-filters these so this branch is defense-in-depth for
      // other render paths.
      attachment.type satisfies AttachmentWithoutSummaryLine | 'bagel_console'
      return null
  }
}

type TaskStatusAttachment = Extract<Attachment, { type: 'task_status' }>

function TaskStatusMessage({
  attachment,
}: {
  attachment: TaskStatusAttachment
}): React.ReactNode {
  // Killed task status is shown in the CoordinatorTaskPanel.
  // Don't render it again in the chat.
  if (attachment.status === 'killed') {
    return null
  }

  return <GenericTaskStatus attachment={attachment} />
}

function GenericTaskStatus({
  attachment,
}: {
  attachment: TaskStatusAttachment
}): React.ReactNode {
  const bg = useSelectedMessageBg()
  const statusText =
    attachment.status === 'completed'
      ? 'completed in background'
      : attachment.status === 'killed'
        ? 'stopped'
        : attachment.status === 'running'
          ? 'still running in background'
          : attachment.status
  return (
    <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>
      <Text dimColor>{BLACK_CIRCLE} </Text>
      <Text dimColor>
        Task &quot;<Text bold>{attachment.description}</Text>&quot; {statusText}
      </Text>
    </Box>
  )
}

// We allow setting dimColor to false here to help work around the dim-bold bug.
// https://github.com/chalk/chalk/issues/290
function Line({
  dimColor = true,
  children,
  color,
}: {
  dimColor?: boolean
  children: React.ReactNode
  color?: keyof Theme
}): React.ReactNode {
  const bg = useSelectedMessageBg()
  return (
    <Box backgroundColor={bg}>
      <MessageResponse>
        <Text color={color} dimColor={dimColor} wrap="wrap">
          {children}
        </Text>
      </MessageResponse>
    </Box>
  )
}
