/**
 * SleepTool — abort-aware async sleep for proactive mode.
 *
 * Lets the agent yield control and wait for a specified duration. Only
 * available when proactive mode is active. Wakes early on abort signal
 * (user interrupt) or when commands arrive in the message queue.
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isProactiveActive } from '../../proactive/index.js'
import { hasCommandsInQueue } from '../../utils/messageQueueManager.js'
import { SLEEP_TOOL_NAME, DESCRIPTION, SLEEP_TOOL_PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration_seconds: z
      .number()
      .min(1)
      .max(3600)
      .optional()
      .default(60)
      .describe(
        'How long to sleep in seconds (1-3600). Defaults to 60 seconds.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    slept: z.boolean(),
    duration: z.number(),
    interrupted: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

/**
 * Create a sleep promise that resolves after the specified duration,
 * but can be interrupted by an AbortSignal or incoming queue commands.
 */
function interruptibleSleep(
  durationMs: number,
  abortSignal?: AbortSignal,
): Promise<{ actualMs: number; interrupted: boolean }> {
  const start = Date.now()

  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined

    const finish = (interrupted: boolean) => {
      if (timer) clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      resolve({ actualMs: Date.now() - start, interrupted })
    }

    // Main sleep timer
    timer = setTimeout(() => finish(false), durationMs)

    // Poll for queue commands (check every second for early wake)
    pollTimer = setInterval(() => {
      if (hasCommandsInQueue()) {
        finish(true)
      }
    }, 1_000)

    // Abort signal handler
    if (abortSignal) {
      if (abortSignal.aborted) {
        finish(true)
        return
      }
      abortSignal.addEventListener('abort', () => finish(true), { once: true })
    }
  })
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  maxResultSizeChars: 500,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return SLEEP_TOOL_PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return 'Sleep'
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  isEnabled() {
    return isProactiveActive()
  },

  renderToolUseMessage(_input, _output) {
    return null
  },

  async call(input, context) {
    const durationSeconds = input.duration_seconds ?? 60
    const durationMs = durationSeconds * 1_000

    const { actualMs, interrupted } = await interruptibleSleep(
      durationMs,
      context.abortController?.signal,
    )

    return {
      data: {
        slept: true,
        duration: Math.round(actualMs / 1_000),
        interrupted,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
