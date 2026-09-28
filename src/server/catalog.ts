import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { getCommandName, type CommandBase } from '../types/command.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import type { TaskState } from '../tasks/types.js'
import {
  WirePermissionModeSchema,
  type WireCatalog,
  type WireTask,
} from '../session/wire.js'

/** The last bytes of a shell's output, read fresh so no stale tail exists. */
function readOutputTail(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size === 0) return undefined
      const len = Math.min(size, 1024)
      const buffer = Buffer.alloc(len)
      readSync(fd, buffer, 0, len, size - len)
      const text = buffer.toString('utf8')
      // Start at a line boundary; a clipped first line reads as garbage.
      const firstBreak = text.indexOf('\n')
      return firstBreak === -1 || firstBreak === text.length - 1
        ? text
        : text.slice(firstBreak + 1)
    } finally {
      closeSync(fd)
    }
  } catch {
    // A task whose output file is gone has nothing to tail.
    return undefined
  }
}

/**
 * Background work (agents, shells) for the task panel.
 *
 * `outputTail` is read only for shells, and only the last kilobyte: agents'
 * output files are full JSONL transcripts (tailing one puts a wall of raw
 * records in a status row), and reading whole files on every publish would
 * make the panel the most expensive thing on the wire.
 */
export function tasksToWire(tasks: Record<string, TaskState>): WireTask[] {
  return Object.values(tasks).map(task => ({
    id: task.id,
    kind: task.type,
    description: task.description,
    status: task.status,
    startTime: task.startTime,
    endTime: task.endTime,
    ...(task.type === 'local_bash'
      ? {
          command: (task as { command?: string }).command,
          outputTail: readOutputTail(task.outputFile),
        }
      : {}),
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
