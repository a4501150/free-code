import { feature } from 'bun:bundle'
import type { DomainUserContentBlock } from '../../../types/domain.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getAllowedChannels } from '../../../bootstrap/state.js'
import {
  CHANNEL_PERMISSION_REQUEST_METHOD,
  type ChannelPermissionRequestParams,
  findChannelEntry,
} from '../../../services/mcp/channelNotification.js'
import type { ChannelPermissionCallbacks } from '../../../services/mcp/channelPermissions.js'
import {
  filterPermissionRelayClients,
  shortRequestId,
  truncateForPreview,
} from '../../../services/mcp/channelPermissions.js'
import { errorMessage } from '../../../utils/errors.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import { createSessionToolAllowUpdate } from '../../../utils/permissions/PermissionUpdate.js'
import { hasPermissionsToUseTool } from '../../../utils/permissions/permissions.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'
// Dead code elimination: conditional import for the WebUI attach host
/* eslint-disable @typescript-eslint/no-require-imports */
const webuiAttachModule = feature('WEBUI')
  ? (require('../../../webui/attach/hostSingleton.js') as typeof import('../../../webui/attach/hostSingleton.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

type InteractivePermissionParams = {
  ctx: PermissionContext
  description: string
  result: PermissionDecision & { behavior: 'ask' }
  awaitAutomatedChecksBeforeDialog: boolean | undefined
  channelCallbacks?: ChannelPermissionCallbacks
}

/**
 * Handles the interactive (main-agent) permission flow.
 *
 * Pushes a ToolUseConfirm entry to the confirm queue with callbacks:
 * onAbort, onAllow, onReject, recheckPermission, onUserInteraction.
 *
 * Runs permission hooks asynchronously in the background, racing them against
 * user interaction. Uses a resolve-once guard to prevent multiple resolutions.
 *
 * This function does NOT return a Promise -- it sets up callbacks that
 * eventually call `resolve()` to resolve the outer promise owned by
 * the caller.
 */
function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void {
  const {
    ctx,
    description,
    result,
    awaitAutomatedChecksBeforeDialog,
    channelCallbacks,
  } = params

  const { resolve: resolveOnce, isResolved, claim } = createResolveOnce(resolve)
  // Hoisted so local/hook wins can remove the pending channel
  // entry. No "tell remote to dismiss" equivalent — the text sits in your
  // phone, and a stale "yes abc123" after local-resolve falls through
  // tryConsumeReply (entry gone) and gets enqueued as normal chat.
  let channelUnsubscribe: (() => void) | undefined
  // Same for a browser attached over the WebUI socket. Unlike a channel, the
  // browser IS told to dismiss, because it renders a live dialog.
  let webUnsubscribe: (() => void) | undefined
  const cleanupRemoteRacers = (): void => {
    channelUnsubscribe?.()
    webUnsubscribe?.()
  }

  const permissionPromptStartTimeMs = Date.now()
  const displayInput = result.updatedInput ?? ctx.input

  ctx.pushToQueue({
    assistantMessage: ctx.assistantMessage,
    tool: ctx.tool,
    description,
    input: displayInput,
    toolUseContext: ctx.toolUseContext,
    toolUseID: ctx.toolUseID,
    permissionResult: result,
    permissionPromptStartTimeMs,
    onUserInteraction() {},
    onAbort() {
      if (!claim()) return
      cleanupRemoteRacers()
      ctx.logCancelled()
      ctx.logDecision(
        { decision: 'reject', source: { type: 'user_abort' } },
        { permissionPromptStartTimeMs },
      )
      resolveOnce(ctx.cancelAndAbort(undefined, true))
    },
    async onAllow(
      updatedInput,
      permissionUpdates: PermissionUpdate[],
      feedback?: string,
      contentBlocks?: DomainUserContentBlock[],
    ) {
      if (!claim()) return // atomic check-and-mark before await

      cleanupRemoteRacers()

      resolveOnce(
        await ctx.handleUserAllow(
          updatedInput,
          permissionUpdates,
          feedback,
          permissionPromptStartTimeMs,
          contentBlocks,
          result.decisionReason,
        ),
      )
    },
    onReject(feedback?: string, contentBlocks?: DomainUserContentBlock[]) {
      if (!claim()) return

      cleanupRemoteRacers()

      ctx.logDecision(
        {
          decision: 'reject',
          source: { type: 'user_reject', hasFeedback: !!feedback },
        },
        { permissionPromptStartTimeMs },
      )
      resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
    },
    async recheckPermission() {
      if (isResolved()) return
      const freshResult = await hasPermissionsToUseTool(
        ctx.tool,
        ctx.input,
        ctx.toolUseContext,
        ctx.assistantMessage,
        ctx.toolUseID,
      )
      if (freshResult.behavior === 'allow') {
        if (!claim()) return
        cleanupRemoteRacers()
        ctx.removeFromQueue()
        ctx.logDecision({ decision: 'accept', source: 'config' })
        resolveOnce(ctx.buildAllow(freshResult.updatedInput ?? ctx.input))
      }
    },
  })

  // Channel permission relay — send a
  // permission prompt to every active channel (Telegram, iMessage, etc.) via
  // its MCP send_message tool, then race the reply against local/bridge/hook.
  // The inbound "yes abc123" is intercepted in the notification
  // handler (useManageMCPConnections.ts) BEFORE enqueue, so it never reaches
  // Claude as a conversation turn.
  //
  // Unlike the bridge block, this still guards on `requiresUserInteraction` —
  // channel replies are pure yes/no with no `updatedInput` path. In practice
  // the guard is dead code today: all three `requiresUserInteraction` tools
  // (ExitPlanMode, AskUserQuestion, ReviewArtifact) return `isEnabled()===false`
  // when channels are configured, so they never reach this handler.
  //
  // Fire-and-forget send: if callTool fails (channel down, tool missing),
  // the subscription never fires and another racer wins. Graceful degradation
  // — the local dialog is always there as the floor.
  if (
    feature('KAIROS') &&
    channelCallbacks &&
    !ctx.tool.requiresUserInteraction?.()
  ) {
    const channelRequestId = shortRequestId(ctx.toolUseID)
    const allowedChannels = getAllowedChannels()
    const channelClients = filterPermissionRelayClients(
      ctx.toolUseContext.getAppState().mcp.clients,
      name => findChannelEntry(name, allowedChannels) !== undefined,
    )

    if (channelClients.length > 0) {
      // Outbound is structured too (Kenneth's symmetry ask) — server owns
      // message formatting for its platform (Telegram markdown, iMessage
      // rich text, Discord embed). CC sends the RAW parts; server composes.
      // The old callTool('send_message', {text,content,message}) triple-key
      // hack is gone — no more guessing which arg name each plugin takes.
      const params: ChannelPermissionRequestParams = {
        request_id: channelRequestId,
        tool_name: ctx.tool.name,
        description,
        input_preview: truncateForPreview(displayInput),
      }

      for (const client of channelClients) {
        if (client.type !== 'connected') continue // refine for TS
        void client.client
          .notification({
            method: CHANNEL_PERMISSION_REQUEST_METHOD,
            params,
          })
          .catch(e => {
            logForDebugging(
              `Channel permission_request failed for ${client.name}: ${errorMessage(e)}`,
              { level: 'error' },
            )
          })
      }

      const channelSignal = ctx.toolUseContext.abortController.signal
      // Wrap so BOTH the map delete AND the abort-listener teardown happen
      // at every call site. The local/hook wins previously only deleted the
      // map entry — the dead closure stayed registered on the session-scoped abort signal
      // until the session ended. Not a functional bug (Map.delete is
      // idempotent), but it held the closure alive.
      const mapUnsub = channelCallbacks.onResponse(
        channelRequestId,
        response => {
          if (!claim()) return // Another racer won
          cleanupRemoteRacers() // map delete + listener remove, both racers
          ctx.removeFromQueue()
          if (response.behavior === 'allow') {
            ctx.logDecision(
              {
                decision: 'accept',
                source: { type: 'user', permanent: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(ctx.buildAllow(displayInput))
          } else {
            ctx.logDecision(
              {
                decision: 'reject',
                source: { type: 'user_reject', hasFeedback: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(
              ctx.cancelAndAbort(`Denied via channel ${response.fromServer}`),
            )
          }
        },
      )
      channelUnsubscribe = () => {
        mapUnsub()
        channelSignal.removeEventListener('abort', channelUnsubscribe!)
      }

      channelSignal.addEventListener('abort', channelUnsubscribe, {
        once: true,
      })
    }
  }

  // WebUI relay — a fourth racer. A browser attached over the session's Unix
  // socket sees the same prompt and can answer it. Whoever answers first wins
  // through the same claim(); the others are torn down.
  if (feature('WEBUI')) {
    const host = webuiAttachModule?.getAttachHost()
    if (host) {
      const broker = host.permissions
      const webRequestId = broker.newRequestId()
      const webSignal = ctx.toolUseContext.abortController.signal

      const brokerUnsub = broker.open(
        {
          requestId: webRequestId,
          toolName: ctx.tool.name,
          toolUseId: ctx.toolUseID,
          description,
          input: displayInput as Record<string, unknown>,
          blockedPath: result.blockedPath,
          agentId: ctx.assistantMessage.agentId,
          openedAt: permissionPromptStartTimeMs,
        },
        async decision => {
          if (!claim()) return // atomic check-and-mark before await
          cleanupRemoteRacers()
          ctx.removeFromQueue()

          if (decision.behavior === 'allow') {
            // An empty updatedInput means "use the original", which is what a
            // client too small to reconstruct the input sends.
            const updated =
              decision.updatedInput && Object.keys(decision.updatedInput).length
                ? decision.updatedInput
                : displayInput

            if (decision.persist) {
              // Session scope only. The terminal's equivalent writes a durable
              // rule to project-local settings, which a surface reachable from
              // the internet behind one password must not do.
              // `handleUserAllow` logs the decision itself.
              resolveOnce(
                await ctx.handleUserAllow(
                  updated,
                  [createSessionToolAllowUpdate(ctx.tool.name)],
                  undefined,
                  permissionPromptStartTimeMs,
                ),
              )
              return
            }

            ctx.logDecision(
              {
                decision: 'accept',
                source: { type: 'user', permanent: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(ctx.buildAllow(updated))
          } else {
            ctx.logDecision(
              {
                decision: 'reject',
                source: {
                  type: 'user_reject',
                  hasFeedback: !!decision.message,
                },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(
              ctx.cancelAndAbort(decision.message ?? 'Denied from the WebUI'),
            )
          }
        },
      )

      webUnsubscribe = () => {
        brokerUnsub()
        webSignal.removeEventListener('abort', webUnsubscribe!)
      }
      webSignal.addEventListener('abort', webUnsubscribe, { once: true })
    }
  }

  // Skip hooks if they were already awaited in the coordinator branch above
  if (!awaitAutomatedChecksBeforeDialog) {
    // Execute PermissionRequest hooks asynchronously
    // If hook returns a decision before user responds, apply it
    void (async () => {
      if (isResolved()) return
      const currentAppState = ctx.toolUseContext.getAppState()
      const hookDecision = await ctx.runHooks(
        currentAppState.toolPermissionContext.mode,
        result.suggestions,
        result.updatedInput,
        permissionPromptStartTimeMs,
      )
      if (!hookDecision || !claim()) return
      cleanupRemoteRacers()
      ctx.removeFromQueue()
      resolveOnce(hookDecision)
    })()
  }
}

// --

export { handleInteractivePermission }
export type { InteractivePermissionParams }
