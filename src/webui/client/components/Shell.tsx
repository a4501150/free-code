import { useCallback, useMemo, useState } from 'react'
import type { SessionListEntry } from '../../gateway/sessionHub.js'
import { useGateway } from '../hooks/useGateway.js'
import { useSessions } from '../hooks/useSessions.js'
import { createViewStore, useViewStore } from '../store.js'
import { Composer } from './Composer.js'
import { Instruments } from './Instruments.js'
import { PermissionTray } from './PermissionTray.js'
import { SessionRail } from './SessionRail.js'
import { TopBar } from './TopBar.js'
import { Transcript } from './Transcript.js'

export function Shell({ csrf }: { csrf: string }): React.ReactElement {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(false)

  const store = useMemo(() => createViewStore(), [])
  const view = useViewStore(store)

  const gateway = useGateway({
    csrf,
    onEvent: (seq, event) => store.apply(seq, event),
  })
  const sessions = useSessions(csrf)

  /** Attaching is always the same four steps, whatever produced the key. */
  const adopt = useCallback(
    (processKey: string) => {
      store.reset()
      setActiveKey(processKey)
      setRailOpen(false)
      gateway.attach(processKey)
    },
    [gateway, store],
  )

  const select = useCallback(
    (entry: SessionListEntry) => {
      if (!entry.processKey) return
      adopt(entry.processKey)
    },
    [adopt],
  )

  const create = useCallback(
    async (cwd: string): Promise<string | null> => {
      const result = await sessions.create(cwd)
      if (!result.ok) return result.error
      // Attach straight away: the user asked for a session, not a list entry.
      adopt(result.processKey)
      return null
    },
    [adopt, sessions],
  )

  const stop = useCallback(
    (pid: number): void => {
      void sessions.stop(pid)
    },
    [sessions],
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

  const meta = view.meta
  const busy = meta?.state === 'running'
  const pending = view.permissions[0]
  // The browser cannot browse the filesystem, so the only sensible default is a
  // directory some session already runs in.
  const defaultCwd =
    meta?.cwd ?? sessions.entries.find(s => s.live && s.cwd)?.cwd ?? ''

  return (
    <div className={`shell ${railOpen ? 'is-rail-open' : ''}`}>
      <TopBar
        meta={meta}
        connected={gateway.connected}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen(open => !open)}
      />

      <SessionRail
        sessions={sessions.entries}
        activeKey={activeKey}
        activeState={meta?.state}
        defaultCwd={defaultCwd}
        onSelect={select}
        onCreate={create}
        onStop={stop}
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
              gateway.send({
                kind: 'permission_decision',
                requestId: pending.requestId,
                decision: { behavior: 'allow' },
              })
            }
            onDeny={message =>
              gateway.send({
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
              gateway.send({
                kind: 'submit',
                commandId: crypto.randomUUID(),
                content: text,
                delivery,
                sessionEpoch: meta?.sessionEpoch ?? 0,
              })
            }
            onInterrupt={() => gateway.send({ kind: 'interrupt' })}
          />
        ) : null}
      </main>

      <Instruments
        meta={meta}
        todos={view.todos}
        models={view.models}
        onSetMode={mode => gateway.send({ kind: 'set_permission_mode', mode })}
        onSetModel={model => gateway.send({ kind: 'set_model', model })}
      />
    </div>
  )
}
