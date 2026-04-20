/**
 * /proactive — Toggle proactive mode on/off.
 *
 * When enabled, the agent receives periodic <tick> prompts and can take
 * initiative without waiting for user input. SleepTool becomes available
 * for yielding between actions.
 */

import {
  activateProactive,
  deactivateProactive,
  isProactiveActive,
} from '../proactive/index.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'

const proactive = {
  type: 'local-jsx',
  name: 'proactive',
  description: 'Toggle proactive mode',
  isEnabled: () => true,
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        _context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const wasActive = isProactiveActive()

        if (wasActive) {
          deactivateProactive()
          onDone('Proactive mode disabled', { display: 'system' })
        } else {
          activateProactive('command')
          onDone('Proactive mode enabled — you will receive periodic tick prompts', {
            display: 'system',
            metaMessages: [
              '<system-reminder>\nProactive mode is now enabled. Take initiative — explore, act, and make progress without waiting for instructions. You will receive periodic <tick> prompts as check-ins. Use the Sleep tool when there is nothing to do.\n</system-reminder>',
            ],
          })
        }

        return null
      },
    }),
} satisfies Command

export default proactive
