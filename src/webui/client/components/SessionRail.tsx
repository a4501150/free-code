import { useState } from 'react'
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
  defaultCwd,
  onSelect,
  onCreate,
  onStop,
}: {
  sessions: SessionListEntry[]
  activeKey: string | null
  activeState?: string
  defaultCwd: string
  onSelect(entry: SessionListEntry): void
  onCreate(cwd: string): Promise<string | null>
  onStop(pid: number): void
}): React.ReactElement {
  const [cwd, setCwd] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setStarting(true)
    setError((await onCreate(cwd.trim() || defaultCwd)) ?? '')
    setStarting(false)
  }

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
              <li key={key} className="rail__row">
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
                {/* Only a process this gateway spawned may be stopped here. A
                    terminal session is not the browser's to end. */}
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
          })}
        </ul>
      )}

      <form className="rail__new" onSubmit={start}>
        <input
          className="rail__cwd"
          value={cwd}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={defaultCwd || 'working directory'}
          onChange={event => setCwd(event.target.value)}
        />
        <button
          type="submit"
          className="rail__start"
          disabled={starting || !(cwd.trim() || defaultCwd)}
        >
          {starting ? 'starting…' : '+ new session'}
        </button>
        {error ? <p className="rail__error">{error}</p> : null}
      </form>

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
