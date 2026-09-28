/**
 * Pure view decisions for the attached-session TUI transcript.
 *
 * The browser has `webui/client/itemViews.ts`; this is its terminal twin:
 * the row-level choices (glyph, color, fold) that are decisions rather than
 * JSX, so they are unit-testable without a renderer. The two files share the
 * wire-shape reads they genuinely have in common (progress, attachments,
 * task rows, tool-input summaries) by importing the browser module — it is
 * DOM-free by construction.
 */

import type { WireItem, WireStreamDraft } from '../../session/wire.js'
import { summarizeToolInput } from '../../webui/client/itemViews.js'

export {
  summarizeToolInput,
  foldText,
  attachmentGutter,
  compactDividerText,
} from '../../webui/client/itemViews.js'

export type ToolRowView = {
  /** Name as it appears in the row head. */
  name: string
  /** One-line argument summary (may be empty). */
  summary: string
  /** `running` while the id is in meta.inProgressToolUseIds with no result. */
  running: boolean
}

/**
 * The head of a tool-use row, given the result the transcript paired with
 * it (if any) and the still-running ids from session meta.
 */
export function toolRowView(
  item: WireItem,
  result: WireItem | undefined,
  inProgressIds: ReadonlySet<string>,
): ToolRowView {
  return {
    name: item.toolName ?? 'tool',
    summary: summarizeToolInput(item),
    running:
      result === undefined &&
      item.toolUseId !== undefined &&
      inProgressIds.has(item.toolUseId),
  }
}

/** A user row: whether the prompt is visible at all, and what it says. */
export function userRowView(item: WireItem): {
  visible: boolean
  text: string
  imageLabel?: string
} {
  if (item.image) {
    return {
      visible: true,
      text: item.text ?? '',
      imageLabel: `[image ${item.image.mediaType}, ${item.image.bytes} bytes]`,
    }
  }
  return { visible: !item.isMeta && Boolean(item.text), text: item.text ?? '' }
}

export type DraftView = {
  thinking?: string
  text?: string
  tools: Array<{ toolName?: string; partialJson: string }>
}

/**
 * The streaming preview for the running turn. The draft is a cumulative
 * snapshot, so rendering is whole-take: whatever arrived last is the truth.
 * An empty draft (all parts absent) shows nothing.
 */
export function draftView(draft: WireStreamDraft | null): DraftView | null {
  if (!draft) return null
  const tools = draft.tools.map(tool => ({
    toolName: tool.toolName,
    partialJson: tailPartial(tool.partialJson),
  }))
  if (!draft.thinking && !draft.text && tools.length === 0) return null
  return {
    ...(draft.thinking ? { thinking: tailLines(draft.thinking, 3) } : {}),
    ...(draft.text ? { text: draft.text } : {}),
    tools,
  }
}

/** Keep the JSON's tail where the interesting values stream in. */
function tailPartial(json: string): string {
  return json.length <= 160 ? json : '…' + json.slice(-159)
}

/** The last N lines — the preview shows what is being written NOW. */
export function tailLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : '…\n' + lines.slice(-max).join('\n')
}

/** Spinner label per activity phase. */
export function activityLabel(
  activity: string | undefined,
  state: string | undefined,
): string {
  if (activity === 'compacting') return 'compacting context…'
  if (state !== 'running') return state === 'requires_action' ? 'waiting' : ''
  switch (activity) {
    case 'requesting':
      return 'requesting…'
    case 'thinking':
      return 'thinking…'
    case 'responding':
      return 'responding…'
    case 'tool-use':
      return 'running tools…'
    case 'tool-input':
      return 'planning calls…'
    default:
      return 'working…'
  }
}

/** Elapsed time label for the status line. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
