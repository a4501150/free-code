import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionListEntry } from '../../gateway/sessionHub.js'
import type {
  WebPermissionDecision,
  WebPermissionRequest,
} from '../../protocol/attachSchemas.js'
import { useGateway } from '../hooks/useGateway.js'
import { useSessions } from '../hooks/useSessions.js'
import { createViewStore, useViewStore } from '../store.js'
import { Composer } from './Composer.js'
import { InstrumentSheet } from './InstrumentSheet.js'
import { Instruments } from './Instruments.js'
import { PermissionTray } from './PermissionTray.js'
import { approvalInput, PlanTray } from './PlanTray.js'
import { QuestionTray } from './QuestionTray.js'
import { MenuDrawer } from './MenuDrawer.js'
import { TopBar } from './TopBar.js'
import { Transcript } from './Transcript.js'

export function Shell({ csrf }: { csrf: string }): React.ReactElement {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [followSignal, setFollowSignal] = useState(0)

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

  const resume = useCallback(
    async (sessionId: string): Promise<string | null> => {
      const result = await sessions.resume(sessionId)
      if (!result.ok) return result.error
      adopt(result.processKey)
      return null
    },
    [adopt, sessions],
  )

  const stop = useCallback(
    async (pid: number): Promise<string | null> => {
      const result = await sessions.stop(pid)
      return result.ok ? null : result.error
    },
    [sessions],
  )

  // Escape closes the drawer, which is the only way out on a phone that has no
  // keyboard showing and no room for a backdrop tap.
  useEffect(() => {
    if (!railOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setRailOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railOpen])

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

  // Image bytes never ride the transcript, so a reader who wants to see one
  // asks the session for it.
  const fetchImage = useCallback(
    async (itemId: string) => {
      const answer = await gateway.request({ kind: 'get_image', itemId })
      if (!answer.ok) {
        throw new Error(answer.error?.message ?? 'the session refused')
      }
      return answer.result as { mediaType: string; data: string }
    },
    [gateway],
  )

  const meta = view.meta
  const busy = meta?.state === 'running'
  const pending = view.permissions[0]
  // The browser cannot browse the filesystem, so the only sensible default is a
  // directory some session already runs in.
  const defaultCwd =
    meta?.cwd ?? sessions.entries.find(s => s.live && s.cwd)?.cwd ?? ''

  // A permission request is the one thing that must not be missed on a phone,
  // and the sheet sits between it and the composer.
  const hasPending = Boolean(pending)
  useEffect(() => {
    if (hasPending) setSheetOpen(false)
  }, [hasPending])

  function decide(requestId: string, decision: WebPermissionDecision): void {
    gateway.send({ kind: 'permission_decision', requestId, decision })
  }

  /**
   * Two tools cannot be answered yes or no. Both always ask, and the terminal
   * answers them by allowing with an enriched input, so each needs a surface
   * that can produce that input.
   */
  function renderTray(request: WebPermissionRequest): React.ReactElement {
    const queued = view.permissions.length

    if (request.toolName === 'AskUserQuestion') {
      return (
        <QuestionTray
          request={request}
          queued={queued}
          onAnswer={updatedInput =>
            decide(request.requestId, { behavior: 'allow', updatedInput })
          }
          onCancel={() =>
            decide(request.requestId, {
              behavior: 'deny',
              message: 'User declined to answer questions',
            })
          }
        />
      )
    }

    if (request.toolName === 'ExitPlanMode') {
      return (
        <PlanTray
          request={request}
          queued={queued}
          onApprove={mode => {
            // Ordered, not raced: one socket delivers these in sequence, so
            // the mode is in place before the tool runs. An allow cannot
            // carry a permission update, which is how the terminal does it.
            gateway.send({ kind: 'set_permission_mode', mode })
            decide(request.requestId, {
              behavior: 'allow',
              updatedInput: approvalInput(request.input),
            })
          }}
          onKeepPlanning={feedback =>
            decide(request.requestId, {
              behavior: 'deny',
              message: feedback || 'Keep planning',
            })
          }
        />
      )
    }

    return (
      <PermissionTray
        request={request}
        queued={queued}
        onAllow={persist =>
          decide(request.requestId, { behavior: 'allow', persist })
        }
        onDeny={message =>
          decide(request.requestId, {
            behavior: 'deny',
            message: message || undefined,
          })
        }
      />
    )
  }

  return (
    <div className={`shell ${railOpen ? 'is-rail-open' : ''}`}>
      <TopBar
        meta={meta}
        connected={gateway.connected}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen(open => !open)}
      />

      <MenuDrawer
        sessions={sessions.entries}
        activeKey={activeKey}
        activeState={meta?.state}
        defaultCwd={defaultCwd}
        csrf={csrf}
        onSelect={select}
        onCreate={create}
        onResume={resume}
        onStop={stop}
        onClose={() => setRailOpen(false)}
      />

      {/* Only rendered when open, so it can never swallow a tap on the desktop
          layout where the rail is pinned. */}
      {railOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setRailOpen(false)}
        />
      ) : null}

      <main className="main">
        {activeKey ? (
          <Transcript
            items={view.items}
            order={view.order}
            followSignal={followSignal}
            onFetchImage={fetchImage}
          />
        ) : (
          <div className="transcript transcript--empty">
            Pick a session to attach.
          </div>
        )}

        {pending ? renderTray(pending) : null}

        {/* Before the composer in the DOM as well as above it on screen, so
            the tab order matches what the eye sees. Inside `main`, so nothing
            has to track the composer's changing height. */}
        <InstrumentSheet
          meta={meta}
          todos={view.todos}
          open={sheetOpen}
          onToggle={setSheetOpen}
        >
          <Instruments
            meta={meta}
            todos={view.todos}
            models={view.models}
            onSetMode={mode =>
              gateway.send({ kind: 'set_permission_mode', mode })
            }
            onSetModel={model => gateway.send({ kind: 'set_model', model })}
          />
        </InstrumentSheet>

        {activeKey ? (
          <Composer
            busy={busy}
            knownPaths={knownPaths}
            onSubmit={(text, delivery, images) => {
              gateway.send({
                kind: 'submit',
                commandId: crypto.randomUUID(),
                content: text,
                ...(images.length ? { images } : {}),
                delivery,
                sessionEpoch: meta?.sessionEpoch ?? 0,
              })
              setFollowSignal(n => n + 1)
            }}
            onInterrupt={() => gateway.send({ kind: 'interrupt' })}
          />
        ) : null}
      </main>
    </div>
  )
}
