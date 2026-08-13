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

export function SessionRail({
  sessions,
  activeKey,
  activeState,
  onSelect,
}: {
  sessions: SessionListEntry[]
  activeKey: string | null
  activeState?: string
  onSelect(entry: SessionListEntry): void
}): React.ReactElement {
  const live = sessions.filter(s => s.live)
  const past = sessions.filter(s => !s.live)

  return (
    <nav className="rail" aria-label="Sessions">
      <h2 className="rail__title">live</h2>
      {live.length === 0 ? (
        <p className="rail__empty">No running sessions.</p>
      ) : (
        <ul className="rail__list">
          {live.map(entry => {
            const key = entry.processKey ?? entry.sessionId
            const isActive = key === activeKey
            return (
              <li key={key}>
                <button
                  type="button"
                  className={`rail__item ${isActive ? 'is-active' : ''} ${
                    entry.attachable ? '' : 'is-disabled'
                  }`}
                  onClick={() => onSelect(entry)}
                  disabled={!entry.attachable}
                >
                  <span
                    className={`rail__glyph is-${
                      isActive ? (activeState ?? 'idle') : 'idle'
                    }`}
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
              </li>
            )
          })}
        </ul>
      )}

      <h2 className="rail__title">history</h2>
      {past.length === 0 ? (
        <p className="rail__empty">Nothing yet.</p>
      ) : (
        <ul className="rail__list">
          {past.slice(0, 40).map(entry => (
            <li key={entry.sessionId}>
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
          ))}
        </ul>
      )}
    </nav>
  )
}
