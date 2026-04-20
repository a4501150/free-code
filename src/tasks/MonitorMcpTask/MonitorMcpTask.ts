import type { TaskStateBase } from '../../Task.js'

/**
 * State carried for an MCP-monitoring background task — a long-running
 * watcher that surfaces MCP server health in the BackgroundTasksDialog.
 *
 * Extends `TaskStateBase` (which already carries `id`, `status`, `description`,
 * `createdAt`, etc.) with the monitor-specific `type` discriminator.
 *
 * The ANT-internal implementation (spawn/kill logic) is not shipped in the
 * source snapshot; the external build never constructs this task. We still
 * need the type declaration so the central `BackgroundTaskState` union in
 * src/tasks/types.ts resolves cleanly.
 */
export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
}
