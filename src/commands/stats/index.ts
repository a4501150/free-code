import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: 'Show your Claude Code usage statistics and activity',
  call: (...args) =>
    import('./stats.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default stats
