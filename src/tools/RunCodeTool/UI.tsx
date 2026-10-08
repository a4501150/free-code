// Rendering for the RunCode code-mode runner. The bridge forwards each child
// tool_use / tool_result as runcode_progress. Collapsed views render one
// lightweight line per call — "calling X…" while pending, a tick/cross plus
// the error headline once resolved. Verbose views replay the child messages
// through the generic Message component (same pattern as SkillTool/AgentTool
// UIs), so nested calls look exactly like direct tool rows. Raw shell
// progress forwarded from inner tools lacks a message and is skipped, as in
// the AgentTool UI.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import { SubAgentProvider } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { Byline } from '../../components/design-system/Byline.js'
import type { ProgressMessage } from '../../types/message.js'
import type { RunCodeProgress, ToolProgressData } from '../../types/tools.js'
import { buildSubagentLookups } from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { renderRunCodeResultText, type RunCodeOutput } from './RunCodeTool.js'

/** Collapsed cap for per-call lines; failed lines always survive the trim. */
const MAX_CALLS_TO_SHOW = 5
/**
 * Collapsed cap for a script error: the throwing call's one-line headline
 * plus the first line of its message. The MCP `### Error` framing strips the
 * payload to its echoed input, which the reader has usually already seen.
 */
const ERROR_HEADLINE_LINES = 2
const ERROR_HEADLINE_CHARS = 120

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

/** `mcp__slack-mcp__slack_read_thread` → `slack_read_thread`; bare names pass through. */
function displayName(name: string): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep > 0) return rest.slice(sep + 2)
  }
  return name
}

function flattenResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: string }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

/** First non-empty line, capped — the headline a collapsed row can afford. */
function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim().length > 0) ?? ''
  return line.trim().slice(0, ERROR_HEADLINE_CHARS)
}

type CallRow = {
  key: string
  name: string
  status: 'running' | 'ok' | 'failed'
  error?: string
}

/** Pair child tool_use blocks with their tool_results into per-call rows. */
function callRowsOf(nested: ProgressMessage<RunCodeProgress>[]): CallRow[] {
  const rows = new Map<string, CallRow>()
  for (const pm of nested) {
    const msg = pm.data.message
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && !rows.has(block.id)) {
          rows.set(block.id, {
            key: block.id,
            name: displayName(block.name),
            status: 'running',
          })
        }
      }
    } else if (msg.type === 'user') {
      const content = Array.isArray(msg.message.content)
        ? msg.message.content
        : []
      for (const block of content) {
        const result = block as {
          type?: string
          tool_use_id?: string
          is_error?: boolean
          content?: unknown
        }
        if (
          result.type !== 'tool_result' ||
          !result.tool_use_id ||
          !rows.has(result.tool_use_id)
        ) {
          continue
        }
        const row = rows.get(result.tool_use_id)!
        if (result.is_error === true) {
          row.status = 'failed'
          row.error = firstLine(flattenResultText(result.content))
        } else {
          row.status = 'ok'
        }
      }
    }
  }
  return [...rows.values()]
}

/**
 * Tail-trim to the cap, keeping every failed row: the line that explains the
 * run must never scroll out of the collapsed view.
 */
function shownRows(
  rows: CallRow[],
  verbose: boolean,
): { displayed: CallRow[]; hidden: number } {
  if (verbose) return { displayed: rows, hidden: 0 }
  const failed = rows.filter(r => r.status === 'failed')
  const rest = rows.filter(r => r.status !== 'failed')
  const keep = Math.max(0, MAX_CALLS_TO_SHOW - failed.length)
  const shown = new Set([...failed, ...rest.slice(-keep)])
  return {
    displayed: rows.filter(r => shown.has(r)),
    hidden: rows.length - shown.size,
  }
}

function renderCallRow(row: CallRow): React.ReactNode {
  if (row.status === 'running') {
    return <Text key={row.key} dimColor>{`calling ${row.name}…`}</Text>
  }
  return (
    <Box key={row.key} flexDirection="row">
      <StatusIcon
        status={row.status === 'ok' ? 'success' : 'error'}
        withSpace
      />
      <Text
        color={row.status === 'failed' ? 'error' : undefined}
        wrap="truncate-end"
      >
        {row.name}
        {row.error ? ` · ${row.error}` : ''}
      </Text>
    </Box>
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
  const calls = countToolUses(nested)
  const header = (
    <Text>
      <Byline>
        <Text dimColor>{running ? 'Running script' : 'Script stopped'}</Text>
        {calls > 0 && (
          <Text dimColor>{`${calls} ${plural(calls, 'call')}`}</Text>
        )}
        {errored.size > 0 && (
          <Text color="error">{`${errored.size} ${plural(errored.size, 'call')} failed`}</Text>
        )}
      </Byline>
    </Text>
  )
  if (verbose) {
    // Full nested replay: child tool_use / tool_result rows identical to
    // direct calls, args and outputs included.
    const { lookups, inProgressToolUseIDs } = buildSubagentLookups(
      nested.map(pm => pm.data),
    )
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {header}
          <SubAgentProvider>
            {nested.map(progressMessage => (
              <MessageComponent
                key={progressMessage.uuid}
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
            ))}
          </SubAgentProvider>
        </Box>
      </MessageResponse>
    )
  }
  const { displayed, hidden } = shownRows(callRowsOf(nested), false)
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {header}
        {displayed.map(renderCallRow)}
        {hidden > 0 && (
          <Text
            dimColor
          >{`+${hidden} more tool ${plural(hidden, 'use')}`}</Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: RunCodeOutput,
  _progressMessagesForMessage?: ProgressMessage<ToolProgressData>[],
  options?: { verbose?: boolean },
): React.ReactNode {
  const rows: CallRow[] = output.segments.map((s, i) => ({
    key: `seg_${i}`,
    name: displayName(s.name),
    status: s.ok ? 'ok' : 'failed',
    error: s.ok ? undefined : firstLine(s.error ?? ''),
  }))
  if (rows.length === 0 && output.logs.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>no tool calls</Text>
      </MessageResponse>
    )
  }
  if (options?.verbose) {
    // Expanded view: each call's full output under its status row, plus the
    // script's console.log block. Segments carry the per-call output text.
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {output.segments.map((s, i) => (
            <Box key={`seg_${i}`} flexDirection="column">
              <Box flexDirection="row">
                <StatusIcon status={s.ok ? 'success' : 'error'} withSpace />
                <Text color={s.ok ? undefined : 'error'} wrap="truncate-end">
                  {displayName(s.name)}
                  {s.ok ? '' : ' · failed'}
                </Text>
              </Box>
              {s.ok ? (
                s.output ? (
                  <OutputLine content={s.output} verbose />
                ) : (
                  <Text dimColor>(no output)</Text>
                )
              ) : (
                <OutputLine content={s.error ?? ''} verbose isError />
              )}
            </Box>
          ))}
          {output.logs.length > 0 && (
            <>
              <Text dimColor>Script output:</Text>
              <OutputLine content={output.logs} verbose />
            </>
          )}
        </Box>
      </MessageResponse>
    )
  }
  const { displayed, hidden } = shownRows(rows, false)
  const logLines = output.logs.length > 0 ? output.logs.split('\n').length : 0
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {displayed.map(renderCallRow)}
        {hidden > 0 && (
          <Text dimColor>{`+${hidden} more ${plural(hidden, 'call')}`}</Text>
        )}
        {logLines > 0 && (
          <Text
            dimColor
          >{`${logLines} ${plural(logLines, 'logged line')}`}</Text>
        )}
      </Box>
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
