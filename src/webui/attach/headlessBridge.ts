import { isEnvTruthy } from '../../utils/envUtils.js'
import type { CanUseToolFn } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import type { UUID } from 'crypto'
import { getStreamActivity } from '../../utils/streamActivity.js'
import type {
  WebPermissionMode,
  WebSessionActivity,
  WebSessionState,
} from '../protocol/attachSchemas.js'
import {
  getAttachHost,
  publishAttachMeta,
  publishAttachTranscript,
  registerAttachRuntime,
  startProcessAttachHost,
} from './hostSingleton.js'
import { executePermissionRequestHooksForHost } from '../../cli/structuredIO.js'
import {
  applyPermissionUpdates,
  createSessionToolAllowUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import { buildSubmitValue } from './runtime.js'

/**
 * Set by the gateway on the children it spawns. A plain `claude -p` in a script
 * has no reason to publish a control socket, so this is opt-in rather than
 * automatic.
 */
export const WEBUI_ATTACH_ENV = 'CLAUDE_CODE_WEBUI_ATTACH'

export function shouldAttachHeadless(): boolean {
  return isEnvTruthy(process.env[WEBUI_ATTACH_ENV])
}

export type HeadlessAttachParams = {
  cwd: string
  getMessages(): readonly Message[]
  isRunning(): boolean
  getModel(): string | undefined
  getPermissionMode(): string | undefined
  interrupt(): void
  setModel(model: string): void
  setPermissionMode(mode: WebPermissionMode): void
  /**
   * Kicks the headless drain loop. Unlike the REPL, enqueueing alone does not
   * start a turn there: the stdin path calls run() after every enqueue.
   */
  requestRun(): void
}

/**
 * Publishes a headless session on an attach socket, so a server-owned session
 * speaks the same protocol as one the user started in a terminal.
 */
export function startHeadlessAttach(params: HeadlessAttachParams): void {
  const host = startProcessAttachHost({
    cwd: params.cwd,
    entrypoint: 'webui-child',
  })
  if (!host) return

  registerAttachRuntime({
    getMessages: () => params.getMessages(),
    getState: (): WebSessionState =>
      host.permissions.pending().length > 0
        ? 'requires_action'
        : params.isRunning()
          ? 'running'
          : 'idle',
    // The phase outlives the turn that set it, so gate on the turn still being
    // in flight rather than showing the last thing the model did.
    getActivity: (): WebSessionActivity | undefined =>
      params.isRunning() ? getStreamActivity() : undefined,
    getModel: () => params.getModel(),
    getPermissionMode: () => params.getPermissionMode(),
    getTodos: () => [],

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

    interrupt() {
      params.interrupt()
    },

    setPermissionMode(mode) {
      params.setPermissionMode(mode)
    },

    setModel(model) {
      params.setModel(model)
    },
  })

  // The headless loop mutates its message array in place, so unlike the REPL
  // there is no setter to hook. Poll instead, and only while a browser is
  // actually attached. Unref'd so it cannot hold a finished process open.
  const timer = setInterval(() => {
    if (!host.hasSubscribers) return
    publishAttachTranscript()
    publishAttachMeta()
  }, 400)
  timer.unref?.()
}

/** Call after the message array changes so an attached browser sees it. */
export function publishHeadlessTranscript(): void {
  publishAttachTranscript()
  publishAttachMeta()
}

/**
 * Makes the browser the permission surface for a headless session.
 *
 * Headless with no permission-prompt tool has nobody to ask, so an `ask`
 * decision is effectively a denial. This routes it to the attached browser
 * instead and waits, which is what makes a server-owned session usable.
 *
 * PermissionRequest hooks race the browser here, as they race the terminal
 * dialog and the structured host. Without that, a hook that answers every
 * other host would be ignored for a gateway-owned session alone.
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

    const host = getAttachHost()
    if (!host) return decision

    const broker = host.permissions
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
          requestId,
          toolName: tool.name,
          toolUseId: toolUseID,
          description: decision.message,
          input: displayInput as Record<string, unknown>,
          blockedPath: decision.blockedPath,
          openedAt: Date.now(),
        },
        browserDecision => {
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
