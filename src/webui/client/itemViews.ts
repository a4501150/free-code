/**
 * Item -> view mappings for the transcript rows that need a decision:
 * progress lines (what label, what detail), attachment rows (which of the
 * typed payloads deserves a real renderer, and what the generic row shows
 * for everything else), and the compact seam.
 *
 * Pure functions on the wire shapes — no DOM, unit-tested directly. The
 * renderer consumes these verbatim; anything cleverer than a label and an
 * optional detail belongs here, not in JSX.
 */

import type { WireItem, WireTask } from '../../session/wire.js'

/**
 * Agent id per tool_use id, gathered from the tool_result items that carry
 * one: the agent receipt names the sidechain it answers for. A tool card
 * with an entry here can offer the sidechain drill-down.
 */
export function agentIdsByToolUse(
  items: Iterable<WireItem>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId && item.agentId) {
      map.set(item.toolUseId, item.agentId)
    }
  }
  return map
}

export type TaskView = {
  /** Marker per task kind, shown in the row gutter. */
  marker: string
  label: string
  /** Status class matching the tray status labels (`is-running`...). */
  statusCls: string
  /** Human duration: running tasks tick against `now`, finished ones are fixed. */
  duration?: string
  command?: string
  outputTail?: string
}

function durationText(start: number, end: number): string {
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function taskView(task: WireTask, now: number): TaskView {
  const marker =
    task.kind === 'local_bash' ? '$' : task.kind === 'local_agent' ? '◈' : '◷'
  const running = task.status === 'running' || task.status === 'pending'
  return {
    marker,
    label: task.description || task.id.slice(0, 8),
    statusCls: `is-${task.status}`,
    ...(task.startTime !== undefined &&
    (running || task.endTime !== undefined) &&
    task.startTime <= (running ? now : (task.endTime ?? now))
      ? {
          duration: durationText(
            task.startTime,
            running ? now : (task.endTime ?? now),
          ),
        }
      : {}),
    ...(typeof task.command === 'string' && task.command
      ? { command: task.command }
      : {}),
    ...(task.outputTail ? { outputTail: task.outputTail } : {}),
  }
}

/**
 * Tool name per tool_use id, gathered from the tool_use items already in
 * the transcript: a progress message carries the id, not the name.
 */
export function toolNamesByUseId(
  items: Iterable<WireItem>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'tool_use' && item.toolUseId && item.toolName) {
      map.set(item.toolUseId, item.toolName)
    }
  }
  return map
}

export type ProgressView = {
  /** The tool the progress is about (its name, or a neutral stand-in). */
  label: string
  /** One short line of what the tool reported, or nothing to show. */
  detail?: string
}

/** A line from progress `data` that is a string field a human would read. */
function progressDetail(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  for (const key of ['message', 'status', 'statusText', 'phase']) {
    const value = d[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  if (typeof d.type === 'string' && d.type.trim()) return d.type.trim()
  return undefined
}

export function progressView(
  item: WireItem,
  toolNames: Map<string, string>,
): ProgressView | null {
  const progress = item.progress
  if (!progress) return null
  return {
    label:
      progress.toolName ??
      (progress.toolUseId ? toolNames.get(progress.toolUseId) : undefined) ??
      'tool',
    detail: progressDetail(progress.data),
  }
}

export type AttachmentView = {
  /** Modifiers for the row's class, e.g. `is-edited_text_file is-add`. */
  cls: string
  label: string
  detail?: string
  /** Detail is code-ish: render it in the mono face. */
  mono?: boolean
}

const MONO_DETAIL = new Set(['edited_text_file', 'directory', 'file'])

/** A one-word badge word for the row's gutter. */
export function attachmentGutter(type: string): string {
  switch (type) {
    case 'file':
    case 'already_read_file':
    case 'compact_file_reference':
      return '◧'
    case 'edited_text_file':
      return '✎'
    case 'directory':
      return '▤'
    case 'task_status':
      return '◷'
    case 'hook_system_message':
      return '⚑'
    case 'mcp_resource':
      return '⛓'
    case 'diagnostics':
      return '∅'
    default:
      return '·'
  }
}

export function attachmentView(item: WireItem): AttachmentView | null {
  const att = item.attachment
  if (!att) return null
  const type = att.type
  const data = (att.data ?? {}) as Record<string, unknown>
  const path = typeof data.path === 'string' ? data.path : undefined
  const cls = `is-${type}`
  const mono = MONO_DETAIL.has(type)

  switch (type) {
    case 'file':
    case 'already_read_file':
    case 'compact_file_reference': {
      const verb = type === 'compact_file_reference' ? 'referenced' : 'read'
      return {
        cls,
        label: path ? `${verb} ${path}` : att.display,
        ...(data.truncated === true
          ? { detail: 'truncated for the model' }
          : {}),
      }
    }
    case 'edited_text_file':
      return {
        cls,
        label: path ? `edited ${path}` : att.display,
        ...(typeof data.snippet === 'string' && data.snippet
          ? { detail: data.snippet, mono: true }
          : {}),
      }
    case 'directory':
      return {
        cls,
        label: path ? `listed ${path}` : att.display,
        ...(typeof data.listing === 'string' && data.listing
          ? { detail: data.listing, mono: true }
          : {}),
      }
    case 'pdf_reference':
      return { cls, label: `pdf ${att.display}` }
    case 'diagnostics':
      return { cls, label: att.display }
    case 'task_status': {
      const status = String(data.status ?? '')
      return {
        cls: `${cls} is-task-${status}`,
        label: `task ${data.taskId ?? att.display}: ${status || '?'}`,
        ...(typeof data.description === 'string' && data.description
          ? { detail: data.description }
          : {}),
      }
    }
    case 'token_usage':
    case 'budget_usd':
      return { cls, label: att.display }
    case 'hook_system_message': {
      const hook = typeof data.hookName === 'string' ? `${data.hookName}: ` : ''
      return { cls, label: `${hook}${att.display}` }
    }
    case 'mcp_resource':
      return { cls, label: `resource ${att.display}` }
    case 'plan_mode':
    case 'plan_mode_exit':
    case 'plan_mode_reentry':
      return { cls, label: att.display }
    case 'command_permissions':
    case 'critical_system_reminder':
    case 'structured_output':
      return {
        cls,
        label: att.display,
        ...(type !== 'structured_output' && att.display
          ? { detail: undefined }
          : {}),
      }
    default:
      // A type the serializer passes through untyped: the generic row.
      return { cls: `${cls} is-generic`, label: att.display }
  }
}

/**
 * One-line summary of a tool call's input: the argument a human scans for,
 * not the whole JSON. Shared by the browser's tool card and the TUI
 * attached-session transcript — the wire carries the input, the summary is
 * a view decision.
 */
export function summarizeToolInput(item: WireItem): string {
  const input = (item.toolInput ?? {}) as Record<string, unknown>
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value) return value
    }
    return undefined
  }
  switch (item.toolName) {
    case 'Bash':
      return first('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
      return first('file_path', 'path') ?? ''
    case 'Glob':
    case 'Grep':
      return first('pattern', 'query') ?? ''
    // Legacy built-in name; MCP agent-browser web_fetch replaced it.
    case 'WebFetch':
    case 'mcp__agent-browser__web_fetch':
      return first('url') ?? ''
    case 'Task':
    case 'Agent':
      return first('description', 'prompt') ?? ''
    default: {
      const keys = Object.keys(input)
      return keys.length
        ? `${keys.length} argument${keys.length > 1 ? 's' : ''}`
        : ''
    }
  }
}

/** The compact seam: what the divider says, keyed off the system subtype. */
export function compactDividerText(item: WireItem): string | null {
  if (item.kind !== 'system') return null
  if (item.subtype === 'compact_boundary') return 'context compacted'
  if (item.subtype === 'microcompact_boundary') return 'context trimmed'
  return null
}

/**
 * A tool result shown to a bounded height: the first `maxLines` and a
 * count of what fell off, so collapsing is never losing.
 */
export function foldText(
  text: string | undefined,
  maxLines: number,
): { text: string; hidden: number } {
  if (!text) return { text: '', hidden: 0 }
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, hidden: 0 }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    hidden: lines.length - maxLines,
  }
}
