/**
 * /dream skill — trigger memory consolidation.
 *
 * Reads daily logs and session transcripts, then synthesizes them into
 * durable memory files using the consolidation prompt. Uses the existing
 * auto-dream infrastructure (consolidationPrompt, DreamTask).
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { registerBundledSkill } from '../bundledSkills.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { getAutoMemPath } from '../../memdir/paths.js'

export function registerDreamSkill(): void {
  registerBundledSkill({
    name: 'dream',
    description:
      'Consolidate recent session history and daily logs into durable memories. Run this periodically to keep your memory fresh and organized.',
    whenToUse:
      'Use when the user asks to consolidate or organize memories, or during quiet hours in assistant mode to synthesize recent learnings.',
    userInvocable: true,
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash(ls:*)',
      'Bash(grep:*)',
      'Bash(cat:*)',
    ],

    async getPromptForCommand(args) {
      const memRoot = getAutoMemPath()

      // Transcript directory: either session-specific or general
      const configDir =
        process.env.CLAUDE_CONFIG_DIR ??
        join(process.env.HOME ?? '~', '.claude')
      const transcriptDir = join(configDir, 'sessions')

      // Check for daily logs directory (assistant-mode layout)
      const logsDir = join(memRoot, 'logs')
      const hasLogs = existsSync(logsDir)

      let extra = ''
      if (args) {
        extra += args
      }
      if (hasLogs) {
        extra += extra
          ? '\n\nDaily logs directory exists — prioritize reviewing recent daily log entries.'
          : 'Daily logs directory exists — prioritize reviewing recent daily log entries.'
      }

      const prompt = buildConsolidationPrompt(memRoot, transcriptDir, extra)

      return [{ type: 'text', text: prompt }]
    },
  })
}
