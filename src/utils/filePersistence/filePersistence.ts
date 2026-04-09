/**
 * File persistence orchestrator (stub).
 *
 * CCR infrastructure has been removed. File persistence requires session
 * ingress auth which is no longer available. All functions return no-op
 * values.
 */

import { logError } from '../log.js'
import { type FilesPersistedEventData, type TurnStartTime } from './types.js'

/**
 * Execute file persistence for modified files in the outputs directory.
 * Currently a no-op — CCR infrastructure removed.
 */
export async function runFilePersistence(
  _turnStartTime: TurnStartTime,
  _signal?: AbortSignal,
): Promise<FilesPersistedEventData | null> {
  return null
}

/**
 * Execute file persistence and emit result via callback.
 * Handles errors internally.
 */
export async function executeFilePersistence(
  turnStartTime: TurnStartTime,
  signal: AbortSignal,
  onResult: (result: FilesPersistedEventData) => void,
): Promise<void> {
  try {
    const result = await runFilePersistence(turnStartTime, signal)
    if (result) {
      onResult(result)
    }
  } catch (error) {
    logError(error)
  }
}

/**
 * Check if file persistence is enabled. Always returns false — CCR
 * infrastructure removed.
 */
export function isFilePersistenceEnabled(): boolean {
  return false
}
