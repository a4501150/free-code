import type { SessionListEntry } from '../../gateway/sessionHub.js'
import { NewSessionForm } from './NewSessionForm.js'
import { HistoryRow, SessionRow } from './SessionRow.js'

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
  const live = sessions.filter(s => s.live)
  const past = sessions.filter(s => !s.live)

  return (
    <nav className="rail" id="session-rail" aria-label="Sessions">
      <h2 className="rail__title">live</h2>
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

      <NewSessionForm defaultCwd={defaultCwd} onCreate={onCreate} />

      <h2 className="rail__title">history</h2>
      {past.length === 0 ? (
        <p className="rail__empty">Nothing yet.</p>
      ) : (
        <ul className="rail__list">
          {past.slice(0, 40).map(entry => (
            <HistoryRow key={entry.sessionId} entry={entry} />
          ))}
        </ul>
      )}
    </nav>
  )
}
