/**
 * Assistant mode lifecycle.
 *
 * The "always-on assistant" is one long-lived headless session hosted by the
 * webui gateway (one per machine). It is spawned with --assistant, which
 * forces the mode via markAssistantForced(); nothing else activates it. The
 * assistant.enabled setting is now only the gateway bootstrap's opt-out, and
 * the workspace's agents/assistant.md is persona/team content, not an
 * activation gate. The TUI joins the session (--assistant attaches the
 * viewer) and cannot initialize it.
 */

import { existsSync, readFileSync, statSync } from 'fs'
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
 * Whether this process runs as the assistant. Only the gateway-spawned
 * child (--assistant → markAssistantForced) activates the mode; a project
 * file or a settings key alone no longer turns an ordinary session into an
 * assistant.
 */
export function isAssistantMode(): boolean {
  return forced
}

/**
 * Display name for the assistant persona, if the user configured one.
 */
export function getAssistantName(): string | undefined {
  return getInitialSettings().assistant?.name
}

/**
 * Mark assistant mode as forced (called from --assistant CLI flag handler).
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

// The attachment getter rebuilds the block on every tool-loop iteration:
// key the persona read on the file's stat so steady state costs one stat and
// no read, and operate directly — the catch is the existence check.
let personaCache: { path: string; statKey: string; text: string } | null = null

function readAssistantPersona(mdPath: string): string | null {
  try {
    const stat = statSync(mdPath)
    const statKey = `${stat.mtimeMs}:${stat.size}`
    if (
      personaCache &&
      personaCache.path === mdPath &&
      personaCache.statKey === statKey
    ) {
      return personaCache.text
    }
    const text = readFileSync(mdPath, 'utf-8')
    personaCache = { path: mdPath, statKey, text }
    return text
  } catch {
    // Missing or unreadable persona file: identity line only.
    return null
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
export function buildAssistantModeBlock(
  assistantActive: boolean,
): string | null {
  const sections: string[] = []

  if (assistantActive) {
    const name = getAssistantName()
    const identity = name
      ? `You are running in assistant mode as ${name}.`
      : 'You are running in assistant mode.'
    const persona = readAssistantPersona(getAssistantMdPath()) ?? identity
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
        `- For actions that are hard to reverse or that other people can see, do not block ` +
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

  if (assistantActive && isAutoMemoryEnabled()) {
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
