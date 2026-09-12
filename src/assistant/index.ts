/**
 * Assistant mode lifecycle.
 *
 * Manages the "always-on assistant" mode where Claude Code operates as a
 * persistent assistant with team context, proactive behavior, and daily logs.
 *
 * Activation: .freecode/agents/assistant.md or .claude/agents/assistant.md
 * must exist in the project root, the assistant.enabled setting must be on,
 * or --assistant CLI flag must be passed (daemon mode).
 */

import { existsSync, readFileSync } from 'fs'
import { getProjectRoot } from '../bootstrap/state.js'
import { logError } from '../utils/log.js'
import { getExistingOrPreferredProjectConfigPath } from '../utils/projectConfigPaths.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { setCliTeammateModeOverride } from '../utils/swarm/backends/teammateModeSnapshot.js'

let forced = false

const ASSISTANT_MD = 'assistant.md'

function getAssistantMdPath(): string {
  return getExistingOrPreferredProjectConfigPath(
    getProjectRoot(),
    'agents',
    ASSISTANT_MD,
  )
}

/**
 * Check if assistant mode should be activated.
 * True if .freecode/agents/assistant.md or .claude/agents/assistant.md exists,
 * the assistant.enabled setting is on, OR --assistant was passed.
 */
export function isAssistantMode(): boolean {
  if (forced) return true
  if (getInitialSettings().assistant?.enabled === true) return true
  try {
    return existsSync(getAssistantMdPath())
  } catch {
    return false
  }
}

/**
 * Whether the assistant settings (or --proactive) request proactive mode.
 */
export function isAssistantProactiveRequested(): boolean {
  return getInitialSettings().assistant?.proactive === true
}

/**
 * Display name for the assistant persona, if the user configured one.
 */
export function getAssistantName(): string | undefined {
  return getInitialSettings().assistant?.name
}

/**
 * Whether --assistant flag forced activation (daemon mode).
 */
export function isAssistantForced(): boolean {
  return forced
}

/**
 * Mark assistant mode as forced (called from --assistant CLI flag handler).
 * Bypasses file existence check and entitlement gate.
 */
export function markAssistantForced(): void {
  forced = true
}

/**
 * Initialize the assistant team context.
 *
 * Reads the preferred/existing project agents assistant.md for team configuration, sets teammate
 * mode to in-process so Agent(name: "foo") spawns teammates without
 * TeamCreate.
 *
 * @returns Team context with teammate names, or undefined if no team config.
 */
export async function initializeAssistantTeam(): Promise<
  { teammates: string[] } | undefined
> {
  try {
    const mdPath = getAssistantMdPath()
    if (!existsSync(mdPath)) return undefined

    const content = readFileSync(mdPath, 'utf-8')

    // Parse teammate definitions from assistant.md
    // Format: ## Team\n- name: description
    const teammates: string[] = []
    const teamSection = content.match(/## Team\s*\n([\s\S]*?)(?=\n##|$)/)
    if (teamSection) {
      const lines = teamSection[1]!.split('\n')
      for (const line of lines) {
        const match = line.match(/^-\s+(\w+)/)
        if (match?.[1]) {
          teammates.push(match[1])
        }
      }
    }

    // Set teammate mode to in-process for assistant mode
    setCliTeammateModeOverride('in-process')

    return teammates.length > 0 ? { teammates } : undefined
  } catch (err) {
    logError(err)
    return undefined
  }
}

/**
 * Get the system prompt addendum for assistant mode.
 * Returns the contents of the preferred/existing project assistant.md wrapped as an
 * assistant-mode section.
 */
export function getAssistantSystemPromptAddendum(): string {
  const name = getAssistantName()
  const identity = name
    ? `You are running in assistant mode as ${name}.`
    : 'You are running in assistant mode.'
  try {
    const mdPath = getAssistantMdPath()
    if (!existsSync(mdPath)) {
      return `# Assistant Mode\n\n${identity}`
    }

    const content = readFileSync(mdPath, 'utf-8')
    return `# Assistant Mode\n\n${content}`
  } catch {
    return `# Assistant Mode\n\n${identity}`
  }
}

/**
 * Get the path to the assistant.md file if it exists.
 * Used for telemetry and diagnostics.
 */
export function getAssistantActivationPath(): string | undefined {
  const mdPath = getAssistantMdPath()
  return existsSync(mdPath) ? mdPath : undefined
}
