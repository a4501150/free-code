import { useState } from 'react'
import type { SessionListEntry } from '../../gateway/sessionHub.js'
import { logout, restartGateway } from '../api.js'
import { SessionRail } from './SessionRail.js'

/**
 * The drawer behind the top-left button.
 *
 * Two levels on a phone, because the gateway actions had nowhere to live above
 * a list that fills the screen. From 48rem the drawer is a permanent column and
 * the button that opens it is hidden, so CSS shows both levels stacked and the
 * navigation row disappears. One tree at every width: rendering one of two
 * copies behind a JavaScript media query would discard state on every crossing.
 */
export function MenuDrawer({
  sessions,
  activeKey,
  activeState,
  defaultCwd,
  csrf,
  onSelect,
  onCreate,
  onResume,
  onStop,
  onClose,
}: {
  sessions: SessionListEntry[]
  activeKey: string | null
  activeState?: string
  defaultCwd: string
  csrf: string
  onSelect(entry: SessionListEntry): void
  onCreate(cwd: string): Promise<string | null>
  onResume(sessionId: string): Promise<string | null>
  onStop(pid: number): Promise<string | null>
  onClose(): void
}): React.ReactElement {
  const [level, setLevel] = useState<'root' | 'sessions'>('root')
  const liveCount = sessions.filter(s => s.live).length

  return (
    <nav
      className={`rail is-${level}`}
      id="session-rail"
      aria-label="Menu"
    >
      <div className="rail__header">
        {level === 'sessions' ? (
          <button
            type="button"
            className="menu__back"
            aria-label="Back to menu"
            onClick={() => setLevel('root')}
          >
            ‹
          </button>
        ) : null}
        {/* Always "menu", never the current level: from 48rem both levels show
            at once, so a title tracking the level would label the wrong half.
            Each level carries its own heading instead. */}
        <h2 className="rail__heading">menu</h2>
        <button
          type="button"
          className="rail__close"
          aria-label="Close menu"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {/* Sessions first in the DOM, because from 48rem both levels are visible
          and this is the order they should be read and tabbed in. Below that
          width only one level is displayed at a time, so their relative order
          is not observable. Reordering with CSS instead would leave the tab
          order disagreeing with the page. */}
      <SessionRail
        sessions={sessions}
        activeKey={activeKey}
        activeState={activeState}
        defaultCwd={defaultCwd}
        onSelect={onSelect}
        onCreate={onCreate}
        onResume={onResume}
        onStop={onStop}
      />

      <div className="menu__level menu__root">
        <button
          type="button"
          className="menu__entry"
          onClick={() => setLevel('sessions')}
        >
          <span className="menu__entry-label">sessions</span>
          <span className="menu__entry-note">
            {liveCount === 1 ? '1 live' : `${liveCount} live`}
          </span>
          <span className="menu__chevron" aria-hidden="true">
            ›
          </span>
        </button>

        <h3 className="rail__title">gateway</h3>
        <GatewayActions csrf={csrf} />
      </div>
    </nav>
  )
}

function GatewayActions({ csrf }: { csrf: string }): React.ReactElement {
  const [confirming, setConfirming] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restart(): Promise<void> {
    setConfirming(false)
    setRestarting(true)
    setError(null)
    const result = await restartGateway(csrf)
    if (!result.ok) {
      setRestarting(false)
      setError(result.error)
    }
    // On success nothing here resets: the gateway is going away, and the socket
    // dropping is the honest signal. The top bar shows reconnecting until the
    // replacement answers.
  }

  return (
    <div className="menu__actions">
      {restarting ? (
        <p className="menu__note">
          Restarting. This page reconnects on its own once the gateway is back.
        </p>
      ) : confirming ? (
        <>
          {/* Said plainly, because it is not obvious that a gateway restart
              takes the session you are reading with it. */}
          <p className="menu__note">
            This stops every session the gateway started, including this one.
            You can resume it from the history afterwards.
          </p>
          <div className="menu__confirm">
            <button
              type="button"
              className="menu__action is-danger"
              onClick={() => void restart()}
            >
              confirm restart
            </button>
            <button
              type="button"
              className="menu__action"
              onClick={() => setConfirming(false)}
            >
              cancel
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="menu__action"
          onClick={() => setConfirming(true)}
        >
          <span aria-hidden="true">↻</span> restart gateway
        </button>
      )}

      <button
        type="button"
        className="menu__action"
        onClick={() => {
          void logout(csrf).then(() => window.location.reload())
        }}
      >
        <span aria-hidden="true">⏻</span> log out
      </button>

      {error ? <p className="rail__error">{error}</p> : null}
    </div>
  )
}
