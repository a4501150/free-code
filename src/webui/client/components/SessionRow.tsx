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

function Label({ entry }: { entry: SessionListEntry }): React.ReactElement {
  return (
    <span className="rail__label">
      <span className="rail__name">{entry.title}</span>
      <span className="rail__meta">
        {shortenPath(entry.cwd)}
        {entry.holders > 1 ? ` · ${entry.holders} holders` : ''}
        {!entry.live && entry.gitBranch ? ` · ${entry.gitBranch}` : ''}
      </span>
    </span>
  )
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
  onStop(pid: number): Promise<string | null>
}): React.ReactElement {
  // Stop is destructive and sits under a thumb, so it takes two deliberate
  // taps. The row key is the process key, so a list poll cannot reset this.
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')

  async function stop(): Promise<void> {
    setStopping(true)
    setError((await onStop(entry.stoppablePid!)) ?? '')
    setStopping(false)
    setConfirming(false)
  }

  return (
    <li className="rail__row">
      <div className="rail__line">
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
          <Label entry={entry} />
        </button>

        {/* Only a process this gateway spawned may be stopped here. A terminal
            session is not the browser's to end. The target is named separately,
            because the row can front a terminal while a gateway child still
            holds the same session. */}
        {entry.owned && entry.stoppablePid ? (
          stopping ? (
            <span className="rail__action is-busy">stopping…</span>
          ) : confirming ? (
            <span className="rail__confirm">
              <button
                type="button"
                className="rail__action is-danger"
                onClick={() => void stop()}
              >
                confirm
              </button>
              <button
                type="button"
                className="rail__action"
                onClick={() => setConfirming(false)}
              >
                cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="rail__action"
              onClick={() => setConfirming(true)}
            >
              stop
            </button>
          )
        ) : null}
      </div>
      {error ? <p className="rail__error">{error}</p> : null}
    </li>
  )
}

export function HistoryRow({
  entry,
  onResume,
}: {
  entry: SessionListEntry
  onResume(sessionId: string): Promise<string | null>
}): React.ReactElement {
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')

  async function resume(): Promise<void> {
    setResuming(true)
    setError((await onResume(entry.sessionId)) ?? '')
    setResuming(false)
  }

  return (
    <li className="rail__row">
      <div className="rail__line">
        {/* An explicit action, not a clickable row: a mis-tap must not start a
            process. */}
        <span className="rail__item is-readonly">
          <span className="rail__glyph">○</span>
          <Label entry={entry} />
        </span>
        <button
          type="button"
          className="rail__action"
          disabled={resuming}
          onClick={() => void resume()}
        >
          {resuming ? 'resuming…' : 'resume'}
        </button>
      </div>
      {error ? <p className="rail__error">{error}</p> : null}
    </li>
  )
}
