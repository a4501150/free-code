/**
 * "Interrupt and send" is one priority enqueue, not cancel then submit; in
 * headless mode every non-stdin producer must call `run()` after `enqueue()`
 * or the turn never starts.
 *
 * `AskUserQuestion` and `ExitPlanMode` require an enriched `updatedInput` —
 * a bare allow silently submits empty answers. Exit-plan approval must also
 * drop `plan`, or it falsely reports a user edit.
 */
import { isWebuiManagedProcess } from '../utils/webuiManagedProcess.js'
import type { CanUseToolFn } from '../Tool.js'
import type { AppState } from '../state/AppStateStore.js'
import type { CommandBase } from '../types/command.js'
import type { Message } from '../types/message.js'
import {
  enqueue,
  getCommandQueueSnapshot,
} from '../utils/messageQueueManager.js'
import type { UUID } from 'crypto'
import {
  getStreamActivity,
  getIsCompacting,
  getInProgressToolUseIds as getGlobalInProgressIds,
  setStreamActivityListener,
} from '../utils/streamActivity.js'
import { currentSessionRequests } from '../session/requests.js'
import { buildRequestUi } from '../session/requestUi.js'
import type {
  WirePendingCommand,
  WirePermissionMode,
  WireSessionActivity,
  WireSessionState,
} from '../session/wire.js'
import {
  publishAttachMeta,
  publishAttachPendingCommands,
  publishAttachTasks,
  publishAttachTranscript,
  registerAttachRuntime,
  startProcessAttachHost,
} from './hostSingleton.js'
import { buildWireTaskSummaries, killAttachTask } from './taskSummaries.js'
import { executePermissionRequestHooksForHost } from '../cli/structuredIO.js'
import {
  applyPermissionUpdates,
  createSessionToolAllowUpdate,
} from '../utils/permissions/PermissionUpdate.js'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  withMemoryCorrectionHint,
} from '../utils/messages.js'
import { buildSubmitValue } from './runtime.js'
import { buildWireCatalog } from './catalog.js'
import { loadAgentWireTranscript } from './agentTranscript.js'

export function shouldAttachHeadless(): boolean {
  return isWebuiManagedProcess()
}

export type HeadlessAttachParams = {
  cwd: string
  getMessages(): readonly Message[]
  /** The live AppState: source for task summaries, transcripts and kills. */
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  isRunning(): boolean
  getModel(): string | undefined
  getPermissionMode(): WirePermissionMode | undefined
  getCommands(): readonly CommandBase[]
  getInProgressToolUseIds?(): ReadonlySet<string>
  interrupt(): void
  /** null returns to the account/config default. */
  setModel(model: string | null): void
  setPermissionMode(mode: WirePermissionMode): void
  requestRun(): void
}

/**
 * Publishes a headless session on a wire surface, so a server-owned session
 * speaks the same protocol as one the user started in a terminal.
 */
export function startHeadlessAttach(params: HeadlessAttachParams): void {
  const surface = startProcessAttachHost({
    cwd: params.cwd,
    entrypoint: 'webui-child',
  })
  if (!surface) return

  registerAttachRuntime({
    getMessages: () => params.getMessages(),
    getState: (): WireSessionState =>
      currentSessionRequests().pending().length > 0
        ? 'requires_action'
        : params.isRunning()
          ? 'running'
          : 'idle',
    getActivity: (): WireSessionActivity | undefined =>
      params.isRunning() ? getStreamActivity() : undefined,
    getIsCompacting: () => getIsCompacting(),
    getModel: () => params.getModel(),
    getPermissionMode: () => params.getPermissionMode(),
    getTodos: () => [],
    getTasks: () => buildWireTaskSummaries(params.getAppState()),
    getAgentTranscript: agentId => loadAgentWireTranscript(agentId),
    getCatalog: () => buildWireCatalog(params.getCommands()),
    getPendingCommands: () => {
      const snapshot = getCommandQueueSnapshot()
      const commands: WirePendingCommand[] = []
      for (const cmd of snapshot) {
        if (cmd.mode !== 'prompt') continue
        const text =
          typeof cmd.value === 'string'
            ? cmd.value
            : cmd.value
                .filter(
                  (b): b is { type: 'text'; text: string } => b.type === 'text',
                )
                .map(b => b.text)
                .join('\n')
        if (text && cmd.uuid) {
          commands.push({ id: cmd.uuid, text, isMeta: cmd.isMeta })
        }
      }
      return commands
    },
    getInProgressToolUseIds: () =>
      params.getInProgressToolUseIds?.() ?? getGlobalInProgressIds(),

    killTask: taskId =>
      killAttachTask(taskId, {
        getAppState: params.getAppState,
        setAppState: params.setAppState,
      }),

    submit(content, delivery, commandId, images) {
      enqueue({
        mode: 'prompt',
        value: buildSubmitValue(content, images),
        priority: delivery === 'interrupt' ? 'now' : 'next',
        uuid: commandId as UUID,
        origin: { kind: 'webui' },
      })
      params.requestRun()
    },

    cancel() {
      params.interrupt()
    },

    setMode(mode) {
      params.setPermissionMode(mode)
    },

    setModel(model) {
      params.setModel(model)
    },
  })

  // Compacting state changes must reach the browser immediately, not on the
  // next publish, or a fast compact is invisible.
  setStreamActivityListener(() => {
    publishAttachMeta()
    publishAttachTranscript()
  })
}

/** Call after the message array changes so an attached browser sees it. */
export function publishHeadlessTranscript(): void {
  publishAttachTranscript()
  publishAttachMeta()
  publishAttachPendingCommands()
  publishAttachTasks()
}

/**
 * Makes the browser the permission surface for a headless session.
 *
 * Headless with no permission-prompt tool has nobody to ask, so an `ask`
 * decision is effectively a denial. This routes it to the attached browser
 * instead and waits, which is what makes a server-owned session usable.
 *
 * The request opens on the session's request broker — the same single
 * ask/race site the interactive dialog uses — so the wire surface announces
 * it and any attached client can answer. PermissionRequest hooks race the
 * browser here, as they race the terminal dialog and the structured host.
 * Without that, a hook that answers every other host would be ignored for a
 * gateway-owned session alone.
 */
export function wrapCanUseToolWithWebUI(inner: CanUseToolFn): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const decision = await inner(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    )
    if (decision.behavior !== 'ask') return decision

    const broker = currentSessionRequests()
    const requestId = broker.newRequestId()
    const displayInput = decision.updatedInput ?? input

    return new Promise(resolve => {
      let settled = false
      const finish = (value: Awaited<ReturnType<CanUseToolFn>>): void => {
        if (settled) return
        settled = true
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }

      const signal = toolUseContext.abortController.signal
      const onAbort = (): void => {
        finish({
          behavior: 'deny',
          message: 'Aborted before anyone answered',
          decisionReason: {
            type: 'permissionPromptTool',
            permissionPromptToolName: 'webui',
            toolResult: { aborted: true },
          },
        })
      }

      const unsubscribe = broker.open(
        {
          kind: 'permission',
          requestId,
          toolName: tool.name,
          toolUseId: toolUseID,
          description: decision.message,
          input: displayInput as Record<string, unknown>,
          blockedPath: decision.blockedPath,
          openedAt: Date.now(),
          // The ask's display half, so a terminal with the classic dialog
          // components can mount the tool's own permission dialog: its
          // suggested-rule options and the compound-command flag.
          suggestions:
            'suggestions' in decision ? decision.suggestions : undefined,
          subcommandResults:
            decision.decisionReason?.type === 'subcommandResults',
          // The question/plan enrichments, so a surface with the classic
          // dialog components can mount the tool's own dialog (same tag
          // the REPL's interactive handler applies).
          ui: buildRequestUi(
            tool.name,
            displayInput as Record<string, unknown>,
          ),
        },
        response => {
          if (response.kind !== 'permission') return
          const browserDecision = response.decision
          if (browserDecision.behavior === 'allow') {
            const updated =
              browserDecision.updatedInput &&
              Object.keys(browserDecision.updatedInput).length
                ? browserDecision.updatedInput
                : displayInput
            // Rule updates from a classic dialog's options ("always allow
            // this prefix/directory") apply session-scoped only — forced
            // to the in-memory destination, never a durable settings file.
            const ruleUpdates = (browserDecision.updates ?? []).map(update =>
              update.type === 'setMode'
                ? update
                : { ...update, destination: 'session' as const },
            )
            if (ruleUpdates.length > 0) {
              toolUseContext.setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdates(
                  prev.toolPermissionContext,
                  ruleUpdates,
                ),
              }))
            }
            if (browserDecision.persist) {
              // Session scope only, so nothing is written to disk. The
              // terminal's equivalent writes a durable project-local rule,
              // which this surface must not do.
              toolUseContext.setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdates(
                  prev.toolPermissionContext,
                  [createSessionToolAllowUpdate(tool.name)],
                ),
              }))
            }
            // An approval carrying feedback (plan approval's "approve
            // with this feedback") rides the same acceptFeedback field
            // the terminal dialog's path produces.
            finish({
              behavior: 'allow',
              updatedInput: updated,
              ...(browserDecision.feedback?.trim()
                ? { acceptFeedback: browserDecision.feedback.trim() }
                : {}),
            })
          } else {
            // The classic dialog's reject (PermissionContext.cancelAndAbort):
            // a bare reject composes the standard STOP message — the text the
            // transcript's rejected-tool-use renderer keys on — and interrupts
            // the turn; feedback rides the with-reason prefix instead. The
            // wire's absent message IS the bare reject (the browser shell
            // sends `message || undefined`); a subagent gets its own wording.
            const feedback = browserDecision.message?.trim() || undefined
            const sub = !!toolUseContext.agentId
            const message = feedback
              ? withMemoryCorrectionHint(
                  `${sub ? SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX : REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`,
                )
              : withMemoryCorrectionHint(
                  sub ? SUBAGENT_REJECT_MESSAGE : REJECT_MESSAGE,
                )
            finish({
              behavior: 'deny',
              message,
              decisionReason: {
                type: 'permissionPromptTool',
                permissionPromptToolName: 'webui',
                toolResult: { behavior: 'deny' },
              },
            })
            // The classic's bare reject aborts the turn after the decision is
            // in hand (the "[Request interrupted by user for tool use]" row);
            // finish is already settled, so the abort racer cannot overwrite
            // the composed message.
            if (!feedback && !sub) toolUseContext.abortController.abort()
          }
        },
      )

      signal.addEventListener('abort', onAbort, { once: true })

      // Racer two. `finish` is idempotent, so whoever answers first wins and
      // the other is torn down.
      void executePermissionRequestHooksForHost(
        tool.name,
        toolUseID,
        input as Record<string, unknown>,
        toolUseContext,
        decision.suggestions,
      ).then(hookDecision => {
        if (hookDecision) finish(hookDecision)
      })
    })
  }
}
