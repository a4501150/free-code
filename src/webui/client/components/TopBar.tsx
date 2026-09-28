import type { WireSessionMeta } from '../../../session/wire.js'
import { rpcBody } from '../composerViews.js'

export function TopBar({
  meta,
  connected,
  railOpen,
  onToggleRail,
  onRpc,
}: {
  meta: WireSessionMeta | null
  connected: boolean
  railOpen: boolean
  onToggleRail(): void
  /** Session-lifecycle rpc (`compact`, `clear`); bodies from composerViews. */
  onRpc(body: unknown): void
}): React.ReactElement {
  // A turn in flight owns the transcript; compaction and clearing while it
  // runs would race the loop, so the buttons say so instead of queueing.
  const busy = meta?.state === 'running'
  return (
    <header className="topbar">
      {/* A labeled control, because an unlabeled glyph hid every action behind
          something nobody read as a menu. */}
      <button
        type="button"
        className="topbar__menu"
        onClick={onToggleRail}
        aria-expanded={railOpen}
        aria-controls="session-rail"
      >
        <span aria-hidden="true">☰</span> menu
      </button>
      <span className="topbar__title">
        {meta ? meta.sessionId.slice(0, 8) : 'no session'}
      </span>
      {/* Narrow screens hide the instrument column, so carry the one fact that
          motivates opening this on a phone. Cost lives on the sheet handle and
          in session details, which is where it stays readable on every width. */}
      {meta ? (
        <span className="topbar__state">
          <span className={`topbar__glyph is-${meta.state}`}>●</span>
          {meta.state}
          {/* The session sends a phase only while a turn is in flight, so this
              needs no gate of its own. Dimmer, because `state` is the fact and
              the phase is the detail. */}
          {meta.activity ? (
            <span className="topbar__activity">· {meta.activity}</span>
          ) : null}
        </span>
      ) : null}
      {meta ? (
        <span className="topbar__actions">
          <button
            type="button"
            className="topbar__action"
            disabled={busy}
            title={busy ? 'A turn is running' : 'Compact the context'}
            onClick={() => onRpc(rpcBody('compact'))}
          >
            compact
          </button>
          <button
            type="button"
            className="topbar__action"
            disabled={busy}
            title={busy ? 'A turn is running' : 'Clear the transcript'}
            onClick={() => onRpc(rpcBody('clear'))}
          >
            clear
          </button>
        </span>
      ) : null}
      <span className={`topbar__link ${connected ? 'is-up' : 'is-down'}`}>
        {connected ? 'connected' : 'reconnecting…'}
      </span>
    </header>
  )
}
