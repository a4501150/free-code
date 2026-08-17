import { useEffect, useRef } from 'react'
import type { UUID } from 'crypto'
import type { Message } from '../../types/message.js'
import type { Task } from '../../utils/taskSchemas.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import type {
  WebPermissionMode,
  WebSessionActivity,
  WebSessionState,
} from '../protocol/attachSchemas.js'
import {
  publishAttachMeta,
  publishAttachTodos,
  registerAttachRuntime,
} from './hostSingleton.js'
import { buildSubmitValue, type AttachRuntime } from './runtime.js'

export type ReplAttachBridgeParams = {
  messagesRef: { current: readonly Message[] }
  getState: () => WebSessionState
  getActivity: () => WebSessionActivity | undefined
  getModel: () => string | undefined
  getPermissionMode: () => string | undefined
  todos: Task[] | undefined
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
      getModel: () => latest.current.getModel(),
      getPermissionMode: () => latest.current.getPermissionMode(),
      getTodos: () =>
        (latest.current.todos ?? []).map(task => ({
          content: task.subject,
          status: task.status,
          activeForm: task.activeForm,
        })),

      submit(content, delivery, commandId, images) {
        // 'now' is one atomic operation: the REPL's queue watcher aborts the
        // running turn with reason 'interrupt', and the drain then picks this
        // command up. Cancelling and submitting separately would race.
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
  })

  useEffect(() => {
    publishAttachTodos()
  }, [params.todos])
}
