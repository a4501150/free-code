/**
 * The statusline driver for a hosted session.
 *
 * The classic statusline lives in the REPL footer: a component that builds
 * the hook payload from loop state and runs the user's command. A hosted
 * session has no REPL footer — but the loop state is right here, in this
 * session's scope: the transcript, the cost tracker's cumulative counters,
 * the store's permission mode and model. This module mirrors the classic
 * component's schedule (initial run, re-run when the newest assistant
 * message / permission mode / model changes or a cost counter moves,
 * debounced 300ms) using the exact payload builder the component uses
 * (`statusline/payload.ts`), run inside the session's own scope.
 *
 * The result goes to the shared AppState store as `statusLineText` — the
 * same field the classic component writes and the footer reads — so the
 * hosting terminal's viewer renders the line with no extra wire surface.
 * A remote attach has no store share with the session, and the statusline
 * is a terminal-surface feature; it stays the hosting terminal's.
 */
import type { SessionState } from '../bootstrap/state.js'
import { onCostUpdate, runInSessionScope } from '../bootstrap/state.js'
import type { SessionCore } from '../session/SessionCore.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Store } from '../state/store.js'
import {
  buildStatusLineCommandInput,
  getLastAssistantMessageId,
  statusLineShouldDisplay,
} from '../statusline/payload.js'
import { executeStatusLineCommand } from '../utils/hooks.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import type { Message } from '../types/message.js'

const DEBOUNCE_MS = 300

export type HostedStatusLineDeps = {
  scope: SessionState
  core: Pick<SessionCore, 'getMessages' | 'subscribe'>
  store: Store<AppState>
}

/** The non-React twin of useMainLoopModel(): the same selector the classic
 *  StatusLine reads, off the session's store snapshot. */
function mainLoopModelFromStore(s: AppState): ModelName {
  return parseUserSpecifiedModel(
    s.mainLoopModelForSession ??
      s.mainLoopModel ??
      getDefaultMainLoopModelSetting(),
  )
}

export function startHostedStatusLine(deps: HostedStatusLineDeps): () => void {
  const { scope, core, store } = deps
  const settings = getInitialSettings()
  if (!statusLineShouldDisplay(settings)) return () => {}

  let stopped = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let inFlight: AbortController | undefined
  let lastAssistantMessageId: string | null = null
  let lastPermissionMode: string | undefined
  let lastModel: ModelName | undefined

  function doUpdate(): void {
    if (stopped) return
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    void (async () => {
      try {
        const text = await runInSessionScope(scope, async () => {
          const messages = core.getMessages() as Message[]
          const currentMessageId = getLastAssistantMessageId(messages)
          lastAssistantMessageId = currentMessageId
          const s = store.getState()
          const permissionMode = s.toolPermissionContext.mode
          lastPermissionMode = permissionMode
          const model = mainLoopModelFromStore(s)
          lastModel = model
          const input = buildStatusLineCommandInput(
            permissionMode,
            false,
            settings,
            messages,
            Array.from(
              s.toolPermissionContext.additionalWorkingDirectories.keys(),
            ),
            model,
          )
          return executeStatusLineCommand(input, controller.signal)
        })
        if (stopped || controller.signal.aborted) return
        store.setState(prev =>
          prev.statusLineText === text
            ? prev
            : { ...prev, statusLineText: text },
        )
      } catch {
        // The classic component silently ignores statusline failures.
      }
    })()
  }

  function schedule(): void {
    if (stopped) return
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      doUpdate()
    }, DEBOUNCE_MS)
    ;(debounce as { unref?: () => void }).unref?.()
  }

  // Initial run, like the component's mount effect.
  doUpdate()

  // Assistant-message / permission-model changes drive re-runs from the
  // core bus; cost-counter moves (streaming) drive it from the cost tracker.
  const unsubscribeCore = core.subscribe(event => {
    if (
      event.type === 'transcript_appended' ||
      event.type === 'transcript_replaced' ||
      event.type === 'turn_finished'
    ) {
      const currentId = getLastAssistantMessageId(
        core.getMessages() as Message[],
      )
      const s = store.getState()
      if (
        currentId !== lastAssistantMessageId ||
        s.toolPermissionContext.mode !== lastPermissionMode ||
        mainLoopModelFromStore(s) !== lastModel
      )
        schedule()
    }
  })
  const unsubscribeCost = runInSessionScope(scope, () => onCostUpdate(schedule))

  return () => {
    stopped = true
    if (debounce !== undefined) clearTimeout(debounce)
    inFlight?.abort()
    unsubscribeCore()
    unsubscribeCost()
  }
}
