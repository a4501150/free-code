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
import { isAutoMemoryEnabled } from '../memdir/paths.js'
import { buildAssistantDailyLogBlock } from '../memdir/memdir.js'
import { BRIEF_PROACTIVE_SECTION } from '../tools/BriefTool/prompt.js'
import { isBriefEnabled } from '../tools/BriefTool/BriefTool.js'

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
 * Build the assistant/brief guidance block carried by the `assistant_mode`
 * attachment (see src/utils/attachments.ts). Sections are composed by gate,
 * so a brief-only session (user opt-in, no assistant) gets just the reply
 * rules. All volatile bytes (the persona file read, feature gates) are
 * rendered here, at creation time — the attachment replays them byte-
 * identically and re-announces wholesale when this text changes.
 */
export function buildAssistantModeBlock(params: {
  assistantActive: boolean
}): string | null {
  const sections: string[] = []

  if (params.assistantActive) {
    const name = getAssistantName()
    const identity = name
      ? `You are running in assistant mode as ${name}.`
      : 'You are running in assistant mode.'
    let persona = identity
    try {
      const mdPath = getAssistantMdPath()
      if (existsSync(mdPath)) {
        persona = readFileSync(mdPath, 'utf-8')
      }
    } catch {
      // Unreadable persona file: identity line only.
    }
    sections.push(
      `# Assistant Mode\n\n${persona}\n\n` +
        `## Working autonomously\n\n` +
        `You are one long-lived session that wakes on events: a message from the ` +
        `user (web UI or attached terminal), a scheduled task coming due, or an ` +
        `external notification. Between events you idle — there is nothing to poll, ` +
        `and a turn with nothing to do should end quickly and without text.\n\n` +
        `- Act on your best judgment rather than asking for confirmation: read, ` +
        `search, run tests, edit code, and commit when you reach a good stopping ` +
        `point.\n` +
        `- For actions that are hard to reverse or outward-facing, do not block ` +
        `waiting for a human who may be away: take the safer action or leave the ` +
        `action for the user's next message, and say what you deferred and why.\n` +
        `- Do not repeat a question the user has not answered. Invest in what you ` +
        `can learn on your own: what do I not know yet, what can go wrong, what ` +
        `must I verify before calling work done?`,
    )
  }

  if (isBriefEnabled()) {
    sections.push(BRIEF_PROACTIVE_SECTION)
  }

  if (params.assistantActive && isAutoMemoryEnabled()) {
    sections.push(buildAssistantDailyLogBlock())
  }

  return sections.length > 0 ? sections.join('\n\n') : null
}

/**
 * Get the path to the assistant.md file if it exists.
 * Used for telemetry and diagnostics.
 */
export function getAssistantActivationPath(): string | undefined {
  const mdPath = getAssistantMdPath()
  return existsSync(mdPath) ? mdPath : undefined
}
