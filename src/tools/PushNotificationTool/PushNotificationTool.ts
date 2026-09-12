/**
 * PushNotificationTool — send push notifications to the user.
 *
 * Wraps the existing sendNotification() infrastructure from services/notifier.
 * Gated on config settings: agentPushNotifEnabled, taskCompleteNotifEnabled,
 * inputNeededNotifEnabled.
 */

import { z } from 'zod/v4'
import { sendNotification } from '../../services/notifier.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'
const DESCRIPTION = 'Send a push notification to the user'
const PROMPT = `Send a push notification to the user's device/terminal.

Use this to alert the user about:
- Task completion ("your build finished", "PR is ready for review")
- Input needed ("waiting for your decision on X")
- Important events ("deployment succeeded", "tests passed")

The notification will be delivered via the user's configured notification channel (terminal bell, iTerm2, Kitty, system notifications, etc.). Delivery is not guaranteed — check the tool result (sent: true/false) before claiming the user was notified.

Each notification interrupts the user — only use it when an interruption is warranted (e.g., a task they care about has finished, or input is needed and you cannot continue without it).`

const inputSchema = z.strictObject({
  title: z
    .string()
    .max(100)
    .describe('Short notification title (max 100 chars).'),
  body: z.string().max(500).describe('Notification body text (max 500 chars).'),
  priority: z
    .enum(['low', 'normal', 'high'])
    .optional()
    .default('normal')
    .describe('Notification priority level.'),
})
type InputSchema = typeof inputSchema

// Channel methods that mean the notification actually reached a channel
// (see src/services/notifier.ts sendToChannel). Anything else — 'disabled',
// 'no_method_available', 'none', 'error' — means nothing was delivered.
const DELIVERED_METHODS = new Set([
  'iterm2',
  'iterm2_with_bell',
  'kitty',
  'ghostty',
  'terminal_bell',
])

const NOTIF_FAILURE_REASONS: Record<string, string> = {
  disabled:
    'notifications are disabled (preferredNotifChannel: notifications_disabled)',
  no_method_available: 'no notification method available for this terminal',
  none: 'no notification channel configured',
  error: 'notification delivery failed',
}

const outputSchema = z.object({
  sent: z.boolean(),
  error: z.string().optional(),
})
type OutputSchema = typeof outputSchema

type Output = z.infer<OutputSchema>

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  maxResultSizeChars: 500,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema
  },

  get outputSchema(): OutputSchema {
    return outputSchema
  },

  userFacingName() {
    return 'PushNotification'
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  isEnabled() {
    // Check the agent push notification setting
    return getInitialSettings().agentPushNotifEnabled === true
  },

  renderToolUseMessage(input, _output) {
    const title = (input as { title?: string }).title ?? 'Notification'
    return `Sending notification: ${title}`
  },

  async call(input) {
    try {
      // sendNotification requires a TerminalNotification instance.
      // For push notifications from the agent, we create a minimal shim
      // that forwards to the system notification channel.
      const notifOpts = {
        title: input.title,
        message: input.body,
        notificationType: `agent_push_${input.priority ?? 'normal'}`,
      }

      // Create a no-op terminal notification shim — the push notification
      // uses system-level channels (osascript, notify-send, etc.), not
      // terminal sequences. sendNotification dispatches based on the
      // configured preferredNotifChannel.
      const terminalShim = {
        notify: () => {},
        bell: () => {},
      }

      // sendNotification never throws; it resolves with the channel method it
      // used, or a non-delivery marker. Only report sent on real delivery.
      const methodUsed = await sendNotification(
        notifOpts,
        terminalShim as never,
      )
      if (DELIVERED_METHODS.has(methodUsed)) {
        return {
          data: { sent: true },
        }
      }
      return {
        data: {
          sent: false,
          error:
            NOTIF_FAILURE_REASONS[methodUsed] ?? `no delivery (${methodUsed})`,
        },
      }
    } catch (err) {
      return {
        data: {
          sent: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
