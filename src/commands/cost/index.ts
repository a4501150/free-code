/**
 * Cost command - minimal metadata only.
 * Implementation is lazy-loaded from cost.tsx to reduce startup time.
 */
import type { Command } from '../../commands.js'

const cost = {
  type: 'local-jsx',
  name: 'cost',
  description: 'Show session cost and usage',
  call: (...args) =>
    import('./cost.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default cost
