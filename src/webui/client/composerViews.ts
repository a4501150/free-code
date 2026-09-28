/**
 * Pure mapping for the composer area: the slash palette, the interrupt
 * affordance, the queued-command rows. Kept out of the component the same
 * way `itemViews.ts` keeps transcript rows testable — the composer itself is
 * DOM, these decisions are not.
 */
import type {
  WireCatalog,
  WirePendingCommand,
  WireSessionMeta,
} from '../../session/wire.js'

/** One row of the slash dropdown: what to insert, and what to say about it. */
export type PaletteItem = {
  value: string
  /** `description`, secondary text. */
  detail?: string
  /** `argHint` in mono — what the command wants after it. */
  hint?: string
}

const PALETTE_LIMIT = 12

/**
 * The slash palette: prefix matches first, then substring matches, then
 * shorter names, so `/con` puts `/compact` above `/config-mcp`.
 * The catalog's names may or may not carry the leading slash; the dropdown
 * always shows them with it and inserts them with it.
 */
export function slashSuggestions(
  commands: readonly WireCatalog['commands'][number][],
  token: string,
): PaletteItem[] {
  if (!token.startsWith('/')) return []
  const query = token.slice(1).toLowerCase()
  const ranked: { rank: number; name: string; item: PaletteItem }[] = []
  for (const command of commands) {
    const name = command.name.startsWith('/')
      ? command.name
      : `/${command.name}`
    const lower = name.toLowerCase()
    const rank = lower.startsWith(query) ? 0 : lower.includes(query) ? 1 : -1
    if (rank < 0) continue
    ranked.push({
      rank,
      name: lower,
      item: {
        value: name,
        detail: command.description,
        hint: command.argHint,
      },
    })
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )
    .slice(0, PALETTE_LIMIT)
    .map(entry => entry.item)
}

/** The one decision the keyboard makes per keystroke while typing. */
export type SubmitIntent = 'none' | 'next' | 'interrupt' | 'newline'

/**
 * Enter submits, Shift+Enter interrupts a running turn (and is a newline
 * when nothing runs), Alt+Enter is always a newline. Suggestions take
 * precedence and are the caller's own gate.
 */
export function submitIntent(input: {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  busy: boolean
}): SubmitIntent {
  if (input.key !== 'Enter') return 'none'
  if (input.metaKey || input.ctrlKey) return 'none'
  if (input.altKey) return 'newline'
  if (input.shiftKey) return input.busy ? 'interrupt' : 'newline'
  return 'next'
}

/**
 * The busy state the composer reads: only `running` turns the send row into
 * send+steer. `compacting` is an activity of a running session and arrives
 * while state is already `running`.
 */
export function composerBusy(
  meta: WireSessionMeta | null | undefined,
): boolean {
  return meta?.state === 'running'
}

export function composerPlaceholder(busy: boolean): string {
  return busy
    ? 'Message — Enter queues, Shift+Enter interrupts'
    : 'Message, or / for a command'
}

/** A queue row: what to show, and whether it is worth showing. */
export type QueueRow = WirePendingCommand

/** The queued list renders prompts only; meta commands are the session's own. */
export function queueRows(commands: readonly WirePendingCommand[]): QueueRow[] {
  return commands.filter(row => !row.isMeta)
}

/** `{kind:'rpc', method:'queue_edit', params:{commandId, text}}`. */
export function queueEditBody(commandId: string, text: string): unknown {
  return {
    kind: 'rpc',
    method: 'queue_edit',
    params: { commandId, text },
  }
}

export function queueRemoveBody(commandId: string): unknown {
  return { kind: 'rpc', method: 'queue_remove', params: { commandId } }
}

/** Session-lifecycle rpc bodies, shared by whatever hosts the buttons. */
export function rpcBody(method: 'compact' | 'clear'): unknown {
  return { kind: 'rpc', method }
}
