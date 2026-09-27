import {
  getCommandName,
  type CommandBase,
} from '../types/command.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import type { TaskState } from '../tasks/types.js'
import {
  WirePermissionModeSchema,
  type WireCatalog,
  type WireTask,
} from '../session/wire.js'

/**
 * Background work (agents, shells) for the task panel.
 *
 * `outputTail` is left out: the panel tails the task's output file directly,
 * and reading every file on every publish would make the panel the most
 * expensive thing on the wire.
 */
export function tasksToWire(
  tasks: Record<string, TaskState>,
): WireTask[] {
  return Object.values(tasks).map(task => ({
    id: task.id,
    kind: task.type,
    description: task.description,
    status: task.status,
  }))
}

/**
 * The catalog of choices the session currently offers.
 *
 * Both process kinds build it the same way so a client sees one shape of
 * "what can I switch to" regardless of who owns the session. A misconfigured
 * provider registry must not break the wire, so the model list degrades to
 * empty rather than throwing on the publish path.
 */
export function buildWireCatalog(
  commands: readonly CommandBase[],
): WireCatalog {
  let models: WireCatalog['models'] = []
  try {
    models = getModelOptions().map(option => ({
      // The null-valued entry IS the "Default" choice on the v2 wire —
      // `model_set` carries null to return to it.
      value: typeof option.value === 'string' ? option.value : null,
      label: option.label,
    }))
  } catch {
    models = []
  }
  return {
    models,
    commands: commands
      .filter(command => !command.isHidden)
      .map(command => ({
        name: getCommandName(command),
        description: command.description,
        argHint: command.argumentHint,
      })),
    permissionModes: WirePermissionModeSchema.options,
  }
}
