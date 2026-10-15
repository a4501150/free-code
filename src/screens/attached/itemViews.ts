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

import type {
  WireItem,
  WireSessionMeta,
  WireStreamDraft,
} from '../../session/wire.js'
import { summarizeToolInput } from '../../webui/client/itemViews.js'
import { PAUSE_ICON } from '../../constants/figures.js'
import {
  getModeColor,
  permissionModeSymbol,
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

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

/**
 * The footer's permission-mode label, word-for-word what the classic
 * REPL's footer left renders: the mode's own symbol and lowercase title
 * for the modes that have one, and the manual-mode pause line for the
 * default. The viewer says exactly what the classic pane says.
 */
export function modeLabel(mode: PermissionMode | undefined): {
  text: string
  /** The mode's own color, or undefined to render dim. */
  color?: ReturnType<typeof getModeColor>
  /** The classic's dim `(shift+tab to cycle)` tail — shown for every
   *  non-default mode, hidden by the footer's two-primary-items rule the
   *  same way the classic footer hides it. */
  hint?: string
} {
  if (!mode || mode === 'default') {
    return { text: `${PAUSE_ICON} manual mode on` }
  }
  return {
    text: `${permissionModeSymbol(mode)} ${permissionModeTitle(mode).toLowerCase()} on`,
    color: getModeColor(mode),
    hint: ' (shift+tab to cycle)',
  }
}

/**
 * The classic-parity bottom bar: the mode label (see `modeLabel`) plus the
 * hint the classic footer shows for the state. The classic footer carries
 * nothing on its right — model and cost live in the banner and `/status`,
 * and the optional StatusLine is off unless configured — so neither does
 * this one.
 */
export function bottomBarParts(opts: {
  running: boolean
  /** A blocking tray owns the keys; the hint says so. */
  waitingForUser?: boolean
}): { left: string } {
  return {
    left: opts.waitingForUser
      ? 'answer above to continue'
      : opts.running
        ? 'esc to interrupt'
        : '? for shortcuts',
  }
}
