/**
 * What a session the serve process hosts gets for free.
 *
 * The old gateway spawned a full CLI per child session, so the child's own
 * startup assembled the tool pool, the slash-command registry and the
 * permission context from its cwd and the gateway's inherited flags. A
 * hosted session needs the same assembly without the process: this is the
 * core-construction counterpart of those CLI flags.
 *
 * MCP servers, plugins and the `--settings` file are not assembled here
 * yet; hosted sessions run on built-ins plus project slash commands.
 */

import { getCommands } from '../commands.js'
import { getTools } from '../tools.js'
import { applyCoordinatorToolFilter } from '../utils/toolPool.js'
import { isCoordinatorMode } from '../coordinator/coordinatorModeGate.js'
import { initializeToolPermissionContext } from '../utils/permissions/permissionSetup.js'
import type { SessionDefaults } from './registry.js'

export type SessionDefaultsRequest = SessionDefaults & {
  /** Inherited from the `web start` flags, as the spawned child used to get them. */
  allowedTools?: string[]
  disallowedTools?: string[]
}

export async function assembleSessionDefaults(
  cwd: string,
  request: SessionDefaultsRequest | undefined,
): Promise<SessionDefaults> {
  const { toolPermissionContext } = await initializeToolPermissionContext({
    allowedToolsCli: request?.allowedTools ?? [],
    disallowedToolsCli: request?.disallowedTools ?? [],
    permissionMode: request?.permissionMode ?? 'default',
    allowDangerouslySkipPermissions: false,
    addDirs: [],
  })
  const commands = await getCommands(cwd)
  let tools = getTools(toolPermissionContext)
  if (isCoordinatorMode()) tools = applyCoordinatorToolFilter(tools)
  return {
    ...request,
    // The store's context type is the DeepImmutable sibling of the one
    // permissionSetup returns; structurally identical.
    toolPermissionContext:
      toolPermissionContext as unknown as SessionDefaults['toolPermissionContext'],
    commands,
    tools: [...tools],
  }
}
