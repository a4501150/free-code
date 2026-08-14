import type { WebSessionMeta } from '../../protocol/attachSchemas.js'

export function TopBar({
  meta,
  connected,
  railOpen,
  onToggleRail,
}: {
  meta: WebSessionMeta | null
  connected: boolean
  railOpen: boolean
  onToggleRail(): void
}): React.ReactElement {
  return (
    <header className="topbar">
      {/* A labeled control, because an unlabeled glyph hid every session
          action behind something nobody read as a menu. */}
      <button
        type="button"
        className="topbar__menu"
        onClick={onToggleRail}
        aria-expanded={railOpen}
        aria-controls="session-rail"
      >
        <span aria-hidden="true">☰</span> sessions
      </button>
      <span className="topbar__title">
        {meta ? meta.sessionId.slice(0, 8) : 'no session'}
      </span>
      {/* Narrow screens hide the instrument column, so carry the two facts
          that motivate opening this on a phone. */}
      {meta ? (
        <span className="topbar__state">
          <span className={`topbar__glyph is-${meta.state}`}>●</span>
          {meta.state}
          <span className="topbar__cost">
            ${(meta.costUsd ?? 0).toFixed(3)}
          </span>
        </span>
      ) : null}
      <span className={`topbar__link ${connected ? 'is-up' : 'is-down'}`}>
        {connected ? 'connected' : 'reconnecting…'}
      </span>
    </header>
  )
}
