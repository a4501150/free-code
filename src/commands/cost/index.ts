/**
 * Cost command - minimal metadata only.
 * Implementation is lazy-loaded from cost.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  get isHidden() {
    return isClaudeAISubscriber()
  },
  supportsNonInteractive: true,
  call: (...args) =>
    import('./cost.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default cost
