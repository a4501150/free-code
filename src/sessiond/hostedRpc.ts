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

import type { UUID } from 'crypto'
import type { SessionId } from '../types/ids.js'
import {
  regenerateSessionId,
  runInSessionScope,
  switchSession,
  type SessionState,
} from '../bootstrap/state.js'
import { fileHistoryRewind } from '../utils/fileHistory.js'
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
  store: {
    getState: () => any
    setState: (fn: (prev: any) => any) => void
  }
  queryGuard: QueryGuard
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  /** The session's resolved model for the compact context assembly. */
  resolveModel: () => string
  /**
   * Load a historical session's main-conversation transcript by id, resolved
   * against THIS session's project directory. Null means no transcript file.
   */
  loadTranscriptMessages: (
    sessionId: string,
  ) => Message[] | null | Promise<Message[] | null>
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
  const {
    scope,
    core,
    channel,
    store,
    queryGuard,
    getToolUseContext,
    resolveModel,
    loadTranscriptMessages,
  } = deps

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

  /**
   * `rewind` — the hosted counterpart of the message selector's restore:
   * truncate the transcript to just before the target message (the same
   * exclusive slice `rewindConversationTo` makes — the target is what the
   * client resubmits, not what it keeps), reset the conversation, restore
   * the permission mode the target was sent under, and optionally run the
   * same file-history snapshot rewind the REPL performs.
   */
  async function rewind(
    toMessageId: string,
    restoreFiles: boolean,
  ): Promise<unknown> {
    if (queryGuard.isActive) {
      throw new Error('a turn is running; cancel it before rewinding')
    }
    const messages = core.getMessages() as Message[]
    const index = messages.findIndex(message => message.uuid === toMessageId)
    if (index === -1) {
      throw new Error(`no transcript message with id '${toMessageId}'`)
    }
    core.replaceMessages(messages.slice(0, index), 'rewind')
    const target = messages[index] as { permissionMode?: string }
    if (target.permissionMode) {
      const mode = target.permissionMode
      store.setState((prev: any) =>
        prev.toolPermissionContext.mode === mode
          ? prev
          : {
              ...prev,
              toolPermissionContext: {
                ...prev.toolPermissionContext,
                mode,
              },
            },
      )
    }
    if (restoreFiles) {
      try {
        await fileHistoryRewind(
          updater =>
            store.setState((prev: any) => ({
              ...prev,
              fileHistory: updater(prev.fileHistory),
            })),
          toMessageId as UUID,
        )
      } catch (err) {
        throw new Error(
          `file restore failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return { rewound: true }
  }

  /**
   * `resume` — load the target session's transcript INTO this session and
   * move the identity onto it, exactly the way `clear` moves it onto a fresh
   * id: one announced transcript replace, one identity rotation, one
   * `session_changed` for every client. `forkSession` keeps the loaded
   * transcript under a regenerated id (lineage recorded) instead of adopting
   * the target's. The transcript is read from this session's project
   * directory — hosted resume is same-project resume; a cross-project target
   * arrives through the registry's own resume path, not this rpc. The
   * SessionEnd/SessionStart hook deviation documented on `clear` applies
   * here too: a hosted resume is a client action on a live session, not a
   * terminal session cycling.
   */
  async function resume(
    targetId: string,
    forkSession: boolean,
  ): Promise<unknown> {
    // `isRunning`, not `isActive`: the in-session /resume command reaches
    // this through its own dispatch (the guard is reserved, no turn is
    // executing), and refusing there would dead-lock the command against
    // itself. A genuine turn in flight still blocks the switch.
    if (queryGuard.isRunning) {
      throw new Error('a turn is running; cancel it before switching sessions')
    }
    const messages = await loadTranscriptMessages(targetId)
    if (!messages || messages.length === 0) {
      throw new Error(`session '${targetId}' has no transcript to resume`)
    }
    core.replaceMessages(messages, 'switch')
    const next = runInSessionScope(scope, () => {
      clearSessionMetadata()
      if (forkSession) {
        return regenerateSessionId({ setCurrentAsParent: true }) as string
      }
      switchSession(targetId as SessionId)
      void resetSessionFilePointer()
      return targetId
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
      case 'rewind': {
        const toMessageId = String(params?.toMessageId ?? '')
        if (!toMessageId) throw new Error('rewind needs a toMessageId')
        return rewind(toMessageId, params?.restoreFiles === true)
      }
      case 'resume': {
        const targetId = String(params?.sessionId ?? '')
        if (!targetId) throw new Error('resume needs a sessionId')
        return resume(targetId, params?.forkSession === true)
      }
      default:
        throw new Error(
          `unsupported rpc method '${method}' (served: compact, clear, rewind, resume, queue_edit, queue_remove)`,
        )
    }
  }
}
