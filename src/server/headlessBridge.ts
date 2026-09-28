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
import type { CommandBase } from '../types/command.js'
import type { Message } from '../types/message.js'
import type { TaskState } from '../tasks/types.js'
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
import type {
  WirePendingCommand,
  WirePermissionMode,
  WireSessionActivity,
  WireSessionState,
} from '../session/wire.js'
import {
  publishAttachMeta,
  publishAttachPendingCommands,
  publishAttachTranscript,
  registerAttachRuntime,
  startProcessAttachHost,
} from './hostSingleton.js'
import { executePermissionRequestHooksForHost } from '../cli/structuredIO.js'
import {
  applyPermissionUpdates,
  createSessionToolAllowUpdate,
} from '../utils/permissions/PermissionUpdate.js'
import { buildSubmitValue } from './runtime.js'
import { buildWireCatalog, tasksToWire } from './catalog.js'
import { loadAgentWireTranscript } from './agentTranscript.js'

export function shouldAttachHeadless(): boolean {
  return isWebuiManagedProcess()
}

export type HeadlessAttachParams = {
  cwd: string
  getMessages(): readonly Message[]
  isRunning(): boolean
  getModel(): string | undefined
  getPermissionMode(): WirePermissionMode | undefined
  getCommands(): readonly CommandBase[]
  getTasks(): Record<string, TaskState>
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
    getTasks: () => tasksToWire(params.getTasks()),
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
            finish({ behavior: 'allow', updatedInput: updated })
          } else {
            finish({
              behavior: 'deny',
              message: browserDecision.message ?? 'Denied from the WebUI',
              decisionReason: {
                type: 'permissionPromptTool',
                permissionPromptToolName: 'webui',
                toolResult: { behavior: 'deny' },
              },
            })
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
