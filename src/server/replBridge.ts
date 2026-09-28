/**
 * `sessionSwitched` also fires for `/clear`; consumers must not assume it
 * means resume.
 */
import { useEffect, useRef } from 'react'
import type { UUID } from 'crypto'
import type { Task as TodoTask } from '../utils/taskSchemas.js'
import type { CommandBase } from '../types/command.js'
import type { TaskState } from '../tasks/types.js'
import {
  enqueue,
  getCommandQueueSnapshot,
} from '../utils/messageQueueManager.js'
import type {
  WirePendingCommand,
  WirePermissionMode,
  WireSessionActivity,
  WireSessionState,
} from '../session/wire.js'
import {
  publishAttachCatalog,
  publishAttachMeta,
  publishAttachPendingCommands,
  publishAttachTasks,
  publishAttachTodos,
  publishAttachTranscript,
  registerAttachRuntime,
} from './hostSingleton.js'
import { buildSubmitValue, type SessionRuntime } from './runtime.js'
import { buildWireCatalog, tasksToWire } from './catalog.js'
import { loadAgentWireTranscript } from './agentTranscript.js'
import type { SessionCore } from '../session/SessionCore.js'

const TRANSCRIPT_EVENT_TYPES = new Set<string>([
  'transcript_appended',
  'transcript_progress_replaced',
  'transcript_replaced',
  'transcript_removed',
])

export type ReplAttachBridgeParams = {
  /** The session core: transcript reads come from it, publishes ride its events. */
  core: SessionCore
  getState: () => WireSessionState
  getActivity: () => WireSessionActivity | undefined
  getIsCompacting: () => boolean
  getModel: () => string | undefined
  getPermissionMode: () => WirePermissionMode | undefined
  getInProgressToolUseIds: () => ReadonlySet<string>
  todos: TodoTask[] | undefined
  commands: readonly CommandBase[]
  tasks: Record<string, TaskState>
  onCancel: () => void
  onSetPermissionMode: (mode: WirePermissionMode) => void
  /** null returns to the account/config default. */
  onSetModel: (model: string | null) => void
}

/**
 * Registers the interactive REPL as the wire runtime.
 *
 * Callbacks live in a ref so the runtime object stays stable across renders,
 * and registration is offered once. The singleton holds it until the surface
 * starts, which happens after session registration resolves.
 */
export function useReplAttachBridge(params: ReplAttachBridgeParams): void {
  const latest = useRef(params)
  latest.current = params

  // Every transcript mutation the core announces (its own loop or a host
  // write) republishes the wire transcript. The serializer diffs, so this
  // is cheap when nothing visible changed and correct when it did — no
  // render-side hook has to remember to publish.
  useEffect(() => {
    return params.core.subscribe(event => {
      if (TRANSCRIPT_EVENT_TYPES.has(event.type)) publishAttachTranscript()
    })
  }, [params.core])

  useEffect(() => {
    const runtime: SessionRuntime = {
      getMessages: () => params.core.getMessages(),
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
      getTasks: () => tasksToWire(latest.current.tasks),
      getCatalog: () => buildWireCatalog(latest.current.commands),
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
                    (b): b is { type: 'text'; text: string } =>
                      b.type === 'text',
                  )
                  .map(b => b.text)
                  .join('\n')
          if (text && cmd.uuid) {
            commands.push({ id: cmd.uuid, text, isMeta: cmd.isMeta })
          }
        }
        return commands
      },
      getInProgressToolUseIds: () => latest.current.getInProgressToolUseIds(),

      // Sidechain drill-down: the sidechain JSONL of this session's project.
      getAgentTranscript: agentId => loadAgentWireTranscript(agentId),

      submit(content, delivery, commandId, images) {
        enqueue({
          mode: 'prompt',
          value: buildSubmitValue(content, images),
          priority: delivery === 'interrupt' ? 'now' : 'next',
          uuid: commandId as UUID,
          origin: { kind: 'webui' },
        })
      },

      cancel() {
        latest.current.onCancel()
      },

      setMode(mode) {
        latest.current.onSetPermissionMode(mode)
      },

      setModel(model) {
        latest.current.onSetModel(model)
      },
    }

    registerAttachRuntime(runtime)
  }, [])

  // Metadata is cheap to build and the surface drops unchanged payloads, so
  // publishing per render keeps state fresh without one subscription per field.
  useEffect(() => {
    publishAttachMeta()
    publishAttachPendingCommands()
  })

  useEffect(() => {
    publishAttachTodos()
    publishAttachTasks()
  }, [params.todos, params.tasks])

  // The command set changes when plugins or MCP servers connect or drop.
  useEffect(() => {
    publishAttachCatalog()
  }, [params.commands])
}
