import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionListEntry } from '../gateway/sessionHub.js'
import {
  connectGateway,
  fetchSessions,
  login,
  whoAmI,
  type GatewaySocket,
  type ServerFrame,
} from './api.js'
import { Composer } from './components/Composer.js'
import { Instruments } from './components/Instruments.js'
import { PermissionTray } from './components/PermissionTray.js'
import { SessionRail } from './components/SessionRail.js'
import { Transcript } from './components/Transcript.js'
import { createViewStore, useViewStore } from './store.js'

function Login({
  onAuthenticated,
}: {
  onAuthenticated(csrf: string): void
}): React.ReactElement {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    const result = await login(password)
    setBusy(false)
    if (result === 'ok') {
      const me = await whoAmI()
      if (me) {
        onAuthenticated(me.csrf)
        return
      }
    }
    setError(
      result === 'throttled'
        ? 'Too many attempts. Wait, then try again.'
        : 'Wrong password.',
    )
    setPassword('')
  }

  return (
    <main className="login">
      <form className="login__form" onSubmit={submit}>
        <h1 className="login__title">claude web</h1>
        <input
          className="login__input"
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="password"
          onChange={event => setPassword(event.target.value)}
        />
        <button
          className="btn btn--send"
          type="submit"
          disabled={busy || !password}
        >
          {busy ? 'checking…' : 'unlock'}
        </button>
        {error ? <p className="login__error">{error}</p> : null}
      </form>
    </main>
  )
}

export function App(): React.ReactElement {
  const [csrf, setCsrf] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [sessions, setSessions] = useState<SessionListEntry[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [railOpen, setRailOpen] = useState(false)

  const store = useMemo(() => createViewStore(), [])
  const view = useViewStore(store)
  const socketRef = useRef<GatewaySocket | null>(null)

  useEffect(() => {
    void whoAmI().then(me => {
      if (me) setCsrf(me.csrf)
      setChecked(true)
    })
  }, [])

  const refresh = useCallback(async () => {
    setSessions(await fetchSessions())
  }, [])

  useEffect(() => {
    if (!csrf) return
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [csrf, refresh])

  const onFrame = useCallback(
    (frame: ServerFrame) => {
      if (frame.type === 'event') store.apply(frame.seq, frame.event)
    },
    [store],
  )

  useEffect(() => {
    if (!csrf) return
    const socket = connectGateway({
      csrf,
      onFrame,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    })
    socketRef.current = socket
    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [csrf, onFrame])

  const select = useCallback(
    (entry: SessionListEntry) => {
      if (!entry.processKey) return
      store.reset()
      setActiveKey(entry.processKey)
      setRailOpen(false)
      socketRef.current?.attach(entry.processKey)
    },
    [store],
  )

  // Paths the session has touched, which is what @ mentions can offer without
  // giving the browser filesystem access.
  const knownPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const item of view.items.values()) {
      const input = item.toolInput as { file_path?: unknown; path?: unknown }
      const value = input?.file_path ?? input?.path
      if (typeof value === 'string') paths.add(value)
    }
    return [...paths]
  }, [view.items])

  if (!checked) return <main className="boot">…</main>
  if (!csrf) return <Login onAuthenticated={setCsrf} />

  const meta = view.meta
  const busy = meta?.state === 'running'
  const pending = view.permissions[0]

  return (
    <div className={`shell ${railOpen ? 'is-rail-open' : ''}`}>
      <header className="topbar">
        <button
          type="button"
          className="topbar__menu"
          onClick={() => setRailOpen(open => !open)}
          aria-label="Toggle sessions"
        >
          ☰
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

      <SessionRail
        sessions={sessions}
        activeKey={activeKey}
        activeState={meta?.state}
        onSelect={select}
      />

      <main className="main">
        {activeKey ? (
          <Transcript items={view.items} order={view.order} />
        ) : (
          <div className="transcript transcript--empty">
            Pick a session to attach.
          </div>
        )}

        {pending ? (
          <PermissionTray
            request={pending}
            queued={view.permissions.length}
            onAllow={() =>
              socketRef.current?.send({
                kind: 'permission_decision',
                requestId: pending.requestId,
                decision: { behavior: 'allow' },
              })
            }
            onDeny={message =>
              socketRef.current?.send({
                kind: 'permission_decision',
                requestId: pending.requestId,
                decision: { behavior: 'deny', message: message || undefined },
              })
            }
          />
        ) : null}

        {activeKey ? (
          <Composer
            busy={busy}
            knownPaths={knownPaths}
            onSubmit={(text, delivery) =>
              socketRef.current?.send({
                kind: 'submit',
                commandId: crypto.randomUUID(),
                content: text,
                delivery,
                sessionEpoch: meta?.sessionEpoch ?? 0,
              })
            }
            onInterrupt={() => socketRef.current?.send({ kind: 'interrupt' })}
          />
        ) : null}
      </main>

      <Instruments
        meta={meta}
        todos={view.todos}
        onSetMode={mode =>
          socketRef.current?.send({ kind: 'set_permission_mode', mode })
        }
      />
    </div>
  )
}
