/**
 * `sessionSwitched` also fires for `/clear`; consumers must not assume it
 * means resume.
 */
import { useEffect, useRef } from 'react'
import type { UUID } from 'crypto'
import type { AppState } from '../state/AppStateStore.ts'
import type { Message } from '../types/message.ts'
import type { Task } from '../utils/taskSchemas.ts'
import {
  enqueue,
  getCommandQueueSnapshot,
} from '../utils/messageQueueManager.ts'
import type {
  WebPendingCommand,
  WebPermissionMode,
  WebSessionActivity,
  WebSessionState,
} from '../webui/protocol/attachSchemas.ts'
import {
  publishAttachMeta,
  publishAttachPendingCommands,
  publishAttachTasks,
  publishAttachTodos,
  registerAttachRuntime,
} from './hostSingleton.ts'
import { buildSubmitValue, type AttachRuntime } from './runtime.ts'
import {
  buildWebTaskSummaries,
  getTaskTranscriptMessages,
  killAttachTask,
} from './taskSummaries.ts'

export type ReplAttachBridgeParams = {
  messagesRef: { current: readonly Message[] }
  getState: () => WebSessionState
  getActivity: () => WebSessionActivity | undefined
  getIsCompacting: () => boolean
  getModel: () => string | undefined
  getPermissionMode: () => string | undefined
  getInProgressToolUseIds: () => ReadonlySet<string>
  todos: Task[] | undefined
  commandNames: string[]
  /** The live AppState: source for task summaries, transcripts and kills. */
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  onCancel: () => void
  onSetPermissionMode: (mode: WebPermissionMode) => void
  onSetModel: (model: string) => void
}

/**
 * Registers the interactive REPL as the attach runtime.
 *
 * Callbacks live in a ref so the runtime object stays stable across renders,
 * and registration is offered once. The singleton holds it until the host
 * starts, which happens after session registration resolves.
 */
export function useReplAttachBridge(params: ReplAttachBridgeParams): void {
  const latest = useRef(params)
  latest.current = params

  useEffect(() => {
    const runtime: AttachRuntime = {
      getMessages: () => latest.current.messagesRef.current,
      getState: () => latest.current.getState(),
      getActivity: () => latest.current.getActivity(),
      getIsCompacting: () => latest.current.getIsCompacting(),
      getModel: () => latest.current.getModel(),
      getPermissionMode: () => latest.current.getPermissionMode(),
      getTodos: () =>
        (latest.current.todos ?? []).map(task => ({
          content: task.subject,
          status: task.status,
          activeForm: task.activeForm,
        })),
      getCommands: () => latest.current.commandNames,
      getPendingCommands: () => {
        const snapshot = getCommandQueueSnapshot()
        const commands: WebPendingCommand[] = []
        for (const cmd of snapshot) {
          if (cmd.mode !== 'prompt') continue
          const text =
            typeof cmd.value === 'string'
              ? cmd.value
              : cmd.value
                  .filter(
                    (b): b is { type: 'text'; text: string } =>
                      b.type === 'text',
                  )
                  .map(b => b.text)
                  .join('\n')
          if (text && cmd.uuid) commands.push({ id: cmd.uuid, text })
        }
        return commands
      },
      getInProgressToolUseIds: () => latest.current.getInProgressToolUseIds(),

      getTasks: () => buildWebTaskSummaries(latest.current.getAppState()),

      getTaskTranscript: taskId =>
        getTaskTranscriptMessages(latest.current.getAppState(), taskId),

      killTask: taskId =>
        killAttachTask(taskId, {
          getAppState: () => latest.current.getAppState(),
          setAppState: prev => latest.current.setAppState(prev),
        }),

      submit(content, delivery, commandId, images) {
        enqueue({
          mode: 'prompt',
          value: buildSubmitValue(content, images),
          priority: delivery === 'interrupt' ? 'now' : 'next',
          uuid: commandId as UUID,
          origin: { kind: 'webui' },
        })
      },

      interrupt() {
        latest.current.onCancel()
      },

      setPermissionMode(mode) {
        latest.current.onSetPermissionMode(mode)
      },

      setModel(model) {
        latest.current.onSetModel(model)
      },
    }

    registerAttachRuntime(runtime)
  }, [])

  // Metadata is cheap to build and the host drops unchanged payloads, so
  // publishing per render keeps state fresh without one subscription per field.
  useEffect(() => {
    publishAttachMeta()
    publishAttachPendingCommands()
    // Task churn happens between renders (a tool call spawning an agent), so
    // the JSON diff in the host rides this tick instead of a store
    // subscription. The host drops an unchanged payload.
    publishAttachTasks()
  })

  useEffect(() => {
    publishAttachTodos()
  }, [params.todos])
}
