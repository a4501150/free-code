import { getInitialSettings } from './settings/settings.js'

/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 * Note: The flag is only shown in help for ant users, but if external users
 * pass it anyway, it will work (subject to the killswitch).
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Requires opt-in via the agentTeamsEnabled setting or the --agent-teams flag.
 */
export function isAgentSwarmsEnabled(): boolean {
  // Require opt-in via the agentTeamsEnabled setting or --agent-teams flag
  if (
    getInitialSettings().agentTeamsEnabled !== true &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  return true
}
