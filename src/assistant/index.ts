/**
 * Assistant mode lifecycle for KAIROS.
 *
 * Manages the "always-on assistant" mode where Claude Code operates as a
 * persistent assistant with team context, proactive behavior, and daily logs.
 *
 * Activation: .claude/agents/assistant.md must exist in the project root,
 * or --assistant CLI flag must be passed (daemon mode).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { logError } from '../utils/log.js'
import { setCliTeammateModeOverride } from '../utils/swarm/backends/teammateModeSnapshot.js'

let forced = false

const ASSISTANT_MD = 'assistant.md'
const AGENTS_DIR = '.claude/agents'

function getAssistantMdPath(): string {
  return join(getProjectRoot(), AGENTS_DIR, ASSISTANT_MD)
}

/**
 * Check if assistant mode should be activated.
 * True if .claude/agents/assistant.md exists OR --assistant was passed.
 */
export function isAssistantMode(): boolean {
  if (forced) return true
  try {
    return existsSync(getAssistantMdPath())
  } catch {
    return false
  }
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
 * Reads .claude/agents/assistant.md for team configuration, sets teammate
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
 * Returns the contents of .claude/agents/assistant.md wrapped as an
 * assistant-mode section.
 */
export function getAssistantSystemPromptAddendum(): string {
  try {
    const mdPath = getAssistantMdPath()
    if (!existsSync(mdPath)) {
      return '# Assistant Mode\n\nYou are running in assistant mode.'
    }

    const content = readFileSync(mdPath, 'utf-8')
    return `# Assistant Mode\n\n${content}`
  } catch {
    return '# Assistant Mode\n\nYou are running in assistant mode.'
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
