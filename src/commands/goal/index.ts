/**
 * Goal command - minimal metadata only.
 * Implementation is lazy-loaded from goal.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '<condition> | clear',
  immediate: true,
  call: (...args) =>
    import('./goal.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default goal
