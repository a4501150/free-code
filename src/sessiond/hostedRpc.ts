/**
 * The rpc surface of a hosted session.
 *
 * The wire's `rpc` command methods — compact, clear, queue_edit,
 * queue_remove — applied to a `HostedSession` without React. The TUI reaches
 * the same code through its slash-command plumbing; here the commands are
 * invoked directly, always inside the session's own scope, and the transcript
 * change goes through the core (so the projection, the persistence watermark
 * and the wire all follow from one announced write).
 */

import {
  regenerateSessionId,
  runInSessionScope,
  type SessionState,
} from '../bootstrap/state.js'
import type { SessionCore } from '../session/SessionCore.js'
import type { SessionChannel } from '../server/channel.js'
import {
  editQueuedCommand,
  removeByFilter,
} from '../utils/messageQueueManager.js'
import { resetSessionFilePointer } from '../utils/sessionStorage.js'
import { clearSessionMetadata } from '../utils/sessionStorage.js'
import type { Message } from '../types/message.js'
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js'
import type { QueryGuard } from '../utils/QueryGuard.js'

export type HostedRpcDeps = {
  scope: SessionState
  core: SessionCore
  channel: SessionChannel
  queryGuard: QueryGuard
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  /** The session's resolved model for the compact context assembly. */
  resolveModel: () => string
}

/**
 * The rpc handler: (method, params) => result. Throws on an unsupported
 * method or an unsafe moment (a turn in flight); the surface answers 500
 * `rpc_failed` with the message. Unknown ids for queue operations answer
 * false rather than throwing — the item simply is not queued anymore.
 */
export function createHostedRpc(
  deps: HostedRpcDeps,
): (method: string, params?: Record<string, unknown>) => Promise<unknown> {
  const { scope, core, channel, queryGuard, getToolUseContext, resolveModel } =
    deps

  async function compact(customInstructions?: string): Promise<unknown> {
    if (queryGuard.isActive) {
      throw new Error('a turn is running; cancel it before compacting')
    }
    // The same framework-free command body the TUI's /compact runs. It calls
    // onCompactProgress on the context — which the hosted context builder
    // wires to core.handleCompactProgress — so the compacting state and its
    // wire events arrive exactly as the announced fact, not a second copy.
    const { call } = await import('../commands/compact/compact.js')
    const context = getToolUseContext(
      core.getMessages() as Message[],
      [],
      new AbortController(),
      resolveModel(),
    )
    const result = await call(customInstructions ?? '', context)
    if (result.type !== 'compact') return { compacted: false }
    const { buildPostCompactMessages } =
      await import('../services/compact/compact.js')
    core.replaceMessages(
      buildPostCompactMessages(result.compactionResult),
      'compact',
    )
    return { compacted: true }
  }

  /**
   * `clear` — the hosted counterpart of /clear. Identity semantics match the
   * TUI: the session ID regenerates (the old one recorded as parent for
   * lineage), the transcript file re-points, and cached session metadata
   * (title/tag) drops so the new session does not wear the old identity. The
   * channel carries the move: setSessionId bumps the epoch, rewrites the
   * descriptor and announces session_changed, so a client holding the old ID
   * resynchronizes rather than writing into a cleared session blindly.
   * Deviation from the TUI command (documented deliberately): SessionEnd /
   * SessionStart hooks do not run — those are terminal-session lifecycle
   * events, and a hosted clear is a client action, not the session ending.
   */
  async function clear(): Promise<unknown> {
    if (queryGuard.isActive) {
      throw new Error('a turn is running; cancel it before clearing')
    }
    core.replaceMessages([], 'switch')
    const next = runInSessionScope(scope, () => {
      clearSessionMetadata()
      const id = regenerateSessionId({ setCurrentAsParent: true })
      void resetSessionFilePointer()
      return id as string
    })
    channel.setSessionId(next)
    return { sessionId: next }
  }

  return async (method, params) => {
    switch (method) {
      case 'compact':
        return runInSessionScope(scope, () =>
          compact(
            typeof params?.customInstructions === 'string'
              ? params.customInstructions
              : undefined,
          ),
        )
      case 'clear':
        return clear()
      case 'queue_edit': {
        const commandId = String(params?.commandId ?? '')
        const text = String(params?.text ?? '')
        if (!commandId) throw new Error('queue_edit needs a commandId')
        const edited = runInSessionScope(scope, () =>
          editQueuedCommand(commandId, text),
        )
        if (edited) channel.publishQueue()
        return { edited }
      }
      case 'queue_remove': {
        const commandId = String(params?.commandId ?? '')
        if (!commandId) throw new Error('queue_remove needs a commandId')
        const removed = runInSessionScope(scope, () =>
          removeByFilter(cmd => cmd.uuid === commandId),
        )
        channel.publishQueue()
        return { removed: removed.length > 0 }
      }
      default:
        throw new Error(
          `unsupported rpc method '${method}' (served: compact, clear, queue_edit, queue_remove)`,
        )
    }
  }
}
