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
import { lazySchema } from '../../utils/lazySchema.js'
import { getGlobalConfig } from '../../utils/config.js'

const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'
const DESCRIPTION = 'Send a push notification to the user'
const PROMPT = `Send a push notification to the user's device/terminal.

Use this to alert the user about:
- Task completion ("your build finished", "PR is ready for review")
- Input needed ("waiting for your decision on X")
- Important events ("deployment succeeded", "tests passed")

The notification will be delivered via the user's configured notification channel (terminal bell, iTerm2, Kitty, system notifications, etc.).

Each notification interrupts the user — only use it when an interruption is warranted (e.g., a task they care about has finished, or input is needed and you cannot continue without it).`

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z
      .string()
      .max(100)
      .describe('Short notification title (max 100 chars).'),
    body: z
      .string()
      .max(500)
      .describe('Notification body text (max 500 chars).'),
    priority: z
      .enum(['low', 'normal', 'high'])
      .optional()
      .default('normal')
      .describe('Notification priority level.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    sent: z.boolean(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'push notification alert notify user',
  maxResultSizeChars: 500,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
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
    const config = getGlobalConfig()
    // Check the agent push notification setting
    return (config as Record<string, unknown>).agentPushNotifEnabled === true
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

      await sendNotification(notifOpts, terminalShim as never)

      return {
        data: { sent: true },
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
