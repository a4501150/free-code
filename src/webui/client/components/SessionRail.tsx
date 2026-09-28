import { useState } from 'react'
import type { SessionListEntry } from '../../../sessiond/sessionList.js'
import { NewSessionForm } from './NewSessionForm.js'
import { HistoryRow, SessionRow } from './SessionRow.js'

/**
 * The sessions level of the menu.
 *
 * The header and the close button belong to `MenuDrawer`, which owns the
 * drawer; this owns only what is specific to sessions.
 */
export function SessionRail({
  sessions,
  activeKey,
  activeState,
  defaultCwd,
  search,
  onSearch,
  onSelect,
  onCreate,
  onResume,
  onStop,
}: {
  sessions: SessionListEntry[]
  activeKey: string | null
  activeState?: string
  defaultCwd: string
  /** The history search text; the server answers history rows only. */
  search: string
  onSearch(q: string): void
  onSelect(entry: SessionListEntry): void
  onCreate(cwd: string): Promise<string | null>
  onResume(sessionId: string): Promise<string | null>
  onStop(pid: number): Promise<string | null>
}): React.ReactElement {
  const [composing, setComposing] = useState(false)

  const live = sessions.filter(s => s.live)
  const past = sessions.filter(s => !s.live)

  return (
    <div className="menu__level menu__sessions">
      <h3 className="rail__title is-lead">sessions</h3>
      {/* The primary action sits above both lists. Buried between them, nobody
          found it. */}
      <div className="menu__new">
        <button
          type="button"
          className="rail__new-toggle"
          aria-expanded={composing}
          onClick={() => setComposing(open => !open)}
        >
          {composing ? 'cancel' : '+ new'}
        </button>
      </div>

      {composing ? (
        <NewSessionForm
          defaultCwd={defaultCwd}
          onCreate={async cwd => {
            const error = await onCreate(cwd)
            if (!error) setComposing(false)
            return error
          }}
        />
      ) : null}

      <h3 className="rail__title">live</h3>
      {live.length === 0 ? (
        <p className="rail__empty">No running sessions.</p>
      ) : (
        <ul className="rail__list">
          {live.map(entry => {
            const key = entry.processKey ?? entry.sessionId
            return (
              <SessionRow
                key={key}
                entry={entry}
                isActive={key === activeKey}
                activeState={activeState}
                onSelect={() => onSelect(entry)}
                onStop={onStop}
              />
            )
          })}
        </ul>
      )}

      <h3 className="rail__title">history</h3>
      {/* The search is server-side (title, cwd, branch): the rail only ever
          holds the first page, and the matches are usually deeper. */}
      <input
        type="search"
        className="rail__search"
        placeholder="search history…"
        aria-label="Search session history"
        value={search}
        onChange={event => onSearch(event.target.value)}
      />
      {past.length === 0 ? (
        <p className="rail__empty">{search ? 'No matches.' : 'Nothing yet.'}</p>
      ) : (
        <ul className="rail__list">
          {/* A search already arrived capped; slicing it again would hide
              the match the user typed for. */}
          {past.slice(0, search ? 50 : 40).map(entry => (
            <HistoryRow
              key={entry.sessionId}
              entry={entry}
              onResume={onResume}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
