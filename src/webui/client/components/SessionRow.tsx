import type { SessionListEntry } from '../../gateway/sessionHub.js'

function stateGlyph(entry: SessionListEntry, state?: string): string {
  if (!entry.live) return '○'
  if (state === 'requires_action') return '◉'
  if (state === 'running') return '◐'
  return '●'
}

function shortenPath(path?: string): string {
  if (!path) return ''
  const parts = path.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : path
}

export function SessionRow({
  entry,
  isActive,
  activeState,
  onSelect,
  onStop,
}: {
  entry: SessionListEntry
  isActive: boolean
  activeState?: string
  onSelect(): void
  onStop(pid: number): void
}): React.ReactElement {
  return (
    <li className="rail__row">
      <button
        type="button"
        className={`rail__item ${isActive ? 'is-active' : ''} ${
          entry.attachable ? '' : 'is-disabled'
        }`}
        onClick={onSelect}
        disabled={!entry.attachable}
      >
        <span
          className={`rail__glyph is-${isActive ? (activeState ?? 'idle') : 'idle'}`}
        >
          {stateGlyph(entry, isActive ? activeState : undefined)}
        </span>
        <span className="rail__label">
          <span className="rail__name">{entry.title}</span>
          <span className="rail__meta">
            {shortenPath(entry.cwd)}
            {entry.holders > 1 ? ` · ${entry.holders} holders` : ''}
          </span>
        </span>
      </button>
      {/* Only a process this gateway spawned may be stopped here. A terminal
          session is not the browser's to end. */}
      {entry.owned && entry.pid ? (
        <button
          type="button"
          className="rail__stop"
          title="Stop this session"
          onClick={() => onStop(entry.pid!)}
        >
          stop
        </button>
      ) : null}
    </li>
  )
}

export function HistoryRow({
  entry,
}: {
  entry: SessionListEntry
}): React.ReactElement {
  return (
    <li>
      {/* Read-only: without a live process there is nothing to drive. */}
      <span className="rail__item is-readonly">
        <span className="rail__glyph">○</span>
        <span className="rail__label">
          <span className="rail__name">{entry.title}</span>
          <span className="rail__meta">
            {shortenPath(entry.cwd)}
            {entry.gitBranch ? ` · ${entry.gitBranch}` : ''}
          </span>
        </span>
      </span>
    </li>
  )
}
