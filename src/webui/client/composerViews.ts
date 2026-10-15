/**
 * Pure mapping for the composer area: the slash palette, the interrupt
 * affordance, the queued-command rows. Kept out of the component the same
 * way `itemViews.ts` keeps transcript rows testable — the composer itself is
 * DOM, these decisions are not.
 */
import Fuse from 'fuse.js'
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
  /** Enter-on-suggestion executes in place (catalog `runsDirectly`). */
  runsDirectly?: boolean
  /** Set when the user's typing matched an ALTERNATIVE name: the row shows
   *  it in parentheses (`/resume (continue)`), like the classic's
   *  createCommandSuggestionItem. */
  matchedAlias?: string
}

const PALETTE_LIMIT = 12

/** One searchable command row, shaped for the classic's Fuse keys. */
type PaletteSearchRow = {
  nameKey: string
  partKey?: string[]
  aliasKey?: string[]
  descriptionKey: string[]
  item: PaletteItem
}

/**
 * The slash palette: the classic generateCommandSuggestions filter and
 * ranking over the wire catalog — Fuse over the name (weight 3), name
 * parts (2), aliases (2) and description words (0.5), then exact name >
 * exact alias > prefix name (shorter first) > prefix alias (shorter first)
 * > score, so `/con` surfaces `/resume (continue)` and `/clear` alongside
 * the `/config` and `/context` name matches.
 * The catalog's names may or may not carry the leading slash; the dropdown
 * always shows them with it and inserts them with it.
 */
export function slashSuggestions(
  commands: readonly WireCatalog['commands'][number][],
  input: string,
): PaletteItem[] {
  if (!input.startsWith('/')) return []
  // The classic's hasCommandArgs gate: arguments typed after the command
  // close the palette entirely (a bare trailing space still shows it).
  if (input.includes(' ') && !input.endsWith(' ')) return []
  const token = input.split(/\s/)[0] ?? input
  const query = token.slice(1).toLowerCase().trim()

  const toRow = (
    command: WireCatalog['commands'][number],
  ): PaletteSearchRow => {
    const name = command.name.startsWith('/')
      ? command.name
      : `/${command.name}`
    const nameKey = name.slice(1).toLowerCase()
    const parts = nameKey.split(/[:_-]/g).filter(Boolean)
    return {
      nameKey,
      partKey: parts.length > 1 ? parts : undefined,
      aliasKey: command.aliases?.map(alias => alias.toLowerCase()),
      // The classic's cleanWord: lowercase, non-alphanumeric dropped.
      descriptionKey: (command.description ?? '')
        .split(' ')
        .map(word => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(Boolean),
      item: {
        value: name,
        detail: command.description,
        hint: command.argHint,
        runsDirectly: command.runsDirectly,
      },
    }
  }

  // For the bare `/` the classic lists commands in its categorized order
  // (built-ins, then user/project prompt commands, then everything else,
  // each category alphabetical) — which is exactly the order the catalog
  // rows already arrive in, so no search and no sort.
  if (query === '')
    return commands.slice(0, PALETTE_LIMIT).map(command => toRow(command).item)

  const fuse = new Fuse(commands.map(toRow), {
    includeScore: true,
    threshold: 0.3,
    location: 0,
    distance: 100,
    keys: [
      { name: 'nameKey', weight: 3 },
      { name: 'partKey', weight: 2 },
      { name: 'aliasKey', weight: 2 },
      { name: 'descriptionKey', weight: 0.5 },
    ],
  })

  const sorted = fuse.search(query).sort((a, b) => {
    const aName = a.item.nameKey
    const bName = b.item.nameKey
    const aAliases = a.item.aliasKey ?? []
    const bAliases = b.item.aliasKey ?? []
    const aExactName = aName === query
    const bExactName = bName === query
    if (aExactName !== bExactName) return aExactName ? -1 : 1
    const aExactAlias = aAliases.includes(query)
    const bExactAlias = bAliases.includes(query)
    if (aExactAlias !== bExactAlias) return aExactAlias ? -1 : 1
    const aPrefixName = aName.startsWith(query)
    const bPrefixName = bName.startsWith(query)
    if (aPrefixName !== bPrefixName) return aPrefixName ? -1 : 1
    if (aPrefixName && bPrefixName && aName.length !== bName.length) {
      return aName.length - bName.length
    }
    const aPrefixAlias = aAliases.find(alias => alias.startsWith(query))
    const bPrefixAlias = bAliases.find(alias => alias.startsWith(query))
    if (aPrefixAlias !== undefined && bPrefixAlias === undefined) return -1
    if (bPrefixAlias !== undefined && aPrefixAlias === undefined) return 1
    if (
      aPrefixAlias !== undefined &&
      bPrefixAlias !== undefined &&
      aPrefixAlias.length !== bPrefixAlias.length
    ) {
      return aPrefixAlias.length - bPrefixAlias.length
    }
    return (a.score ?? 0) - (b.score ?? 0)
  })

  return sorted.slice(0, PALETTE_LIMIT).map(result => {
    // The classic's findMatchedAlias: the parenthetical shows only when
    // the typed query is a prefix of the alias.
    const row = result.item
    const matchedAlias = row.aliasKey?.find(alias => alias.startsWith(query))
    return matchedAlias ? { ...row.item, matchedAlias } : row.item
  })
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
