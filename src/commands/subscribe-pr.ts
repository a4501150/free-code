/**
 * /subscribe-pr — Subscribe to GitHub PR events.
 *
 * Usage: /subscribe-pr owner/repo#123
 *
 * Parses the argument and delegates to SubscribePRTool.
 */

import type { Command, LocalJSXCommandOnDone, LocalJSXCommandContext } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'

const subscribePr = {
  type: 'local-jsx',
  name: 'subscribe-pr',
  description: 'Subscribe to a GitHub pull request for event notifications',
  isEnabled: () => true,
  immediate: false,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        _context: ToolUseContext & LocalJSXCommandContext,
        args?: string,
      ): Promise<React.ReactNode> {
        if (!args) {
          onDone(
            'Usage: /subscribe-pr owner/repo#number\nExample: /subscribe-pr anthropics/claude-code#123',
            { display: 'system' },
          )
          return null
        }

        // Parse owner/repo#number format
        const match = args.trim().match(/^([^/]+)\/([^#]+)#(\d+)$/)
        if (!match) {
          onDone(
            `Could not parse "${args}". Expected format: owner/repo#number`,
            { display: 'system' },
          )
          return null
        }

        const [, owner, repo, prNumStr] = match
        const prNumber = parseInt(prNumStr!, 10)

        // Delegate to SubscribePRTool logic
        const { SubscribePRTool } = await import(
          '../tools/SubscribePRTool/SubscribePRTool.js'
        )

        const result = await SubscribePRTool.call(
          { owner: owner!, repo: repo!, pr_number: prNumber },
          {} as never,
        )

        const data = (result as { data: { subscribed: boolean; pr_url: string; error?: string } }).data

        if (data.subscribed) {
          onDone(`Subscribed to ${owner}/${repo}#${prNumber}\n${data.pr_url}`, {
            display: 'system',
          })
        } else {
          onDone(
            `Failed to subscribe: ${data.error ?? 'unknown error'}`,
            { display: 'system' },
          )
        }

        return null
      },
    }),
} satisfies Command

export default subscribePr
