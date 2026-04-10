/**
 * SubscribePRTool — subscribe to GitHub PR events.
 *
 * Stores PR subscriptions in ~/.claude/pr-subscriptions.json. The proactive
 * tick system polls for PR updates and delivers <github-webhook-activity>
 * XML messages when changes are detected.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  SUBSCRIBE_PR_TOOL_NAME,
  DESCRIPTION,
  SUBSCRIBE_PR_TOOL_PROMPT,
} from './prompt.js'

interface PRSubscription {
  owner: string
  repo: string
  pr_number: number
  subscribed_at: string
  last_checked?: string
  last_state?: string
}

function getSubscriptionsPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '~', '.claude')
  return join(configDir, 'pr-subscriptions.json')
}

function loadSubscriptions(): PRSubscription[] {
  try {
    const path = getSubscriptionsPath()
    if (!existsSync(path)) return []
    return JSON.parse(readFileSync(path, 'utf-8')) as PRSubscription[]
  } catch {
    return []
  }
}

function saveSubscriptions(subs: PRSubscription[]): void {
  const path = getSubscriptionsPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(subs, null, 2), 'utf-8')
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    owner: z.string().describe('Repository owner (e.g. "anthropics").'),
    repo: z.string().describe('Repository name (e.g. "claude-code").'),
    pr_number: z.number().int().positive().describe('Pull request number.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    subscribed: z.boolean(),
    pr_url: z.string(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const SubscribePRTool = buildTool({
  name: SUBSCRIBE_PR_TOOL_NAME,
  searchHint: 'subscribe github pull request PR watch monitor webhook',
  maxResultSizeChars: 2_000,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return SUBSCRIBE_PR_TOOL_PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return 'SubscribePR'
  },

  isReadOnly() {
    return false
  },

  isConcurrencySafe() {
    return true
  },

  renderToolUseMessage(input, _output) {
    const i = input as { owner?: string; repo?: string; pr_number?: number }
    return `Subscribing to ${i.owner}/${i.repo}#${i.pr_number}`
  },

  async call(input) {
    const { owner, repo, pr_number } = input
    const prUrl = `https://github.com/${owner}/${repo}/pull/${pr_number}`

    try {
      // Verify the PR exists using gh CLI
      const proc = Bun.spawnSync({
        cmd: [
          'gh',
          'api',
          `repos/${owner}/${repo}/pulls/${pr_number}`,
          '--jq',
          '.state',
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr).trim()
        return {
          data: {
            subscribed: false,
            pr_url: prUrl,
            error: `Failed to verify PR: ${stderr || 'gh command failed'}`,
          },
        }
      }

      const currentState = new TextDecoder().decode(proc.stdout).trim()

      // Add to subscriptions
      const subs = loadSubscriptions()
      const existing = subs.findIndex(
        s =>
          s.owner === owner &&
          s.repo === repo &&
          s.pr_number === pr_number,
      )

      const subscription: PRSubscription = {
        owner,
        repo,
        pr_number,
        subscribed_at: new Date().toISOString(),
        last_checked: new Date().toISOString(),
        last_state: currentState,
      }

      if (existing >= 0) {
        subs[existing] = subscription
      } else {
        subs.push(subscription)
      }

      saveSubscriptions(subs)

      return {
        data: {
          subscribed: true,
          pr_url: prUrl,
        },
      }
    } catch (err) {
      logError(err)
      return {
        data: {
          subscribed: false,
          pr_url: prUrl,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
