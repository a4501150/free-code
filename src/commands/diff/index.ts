import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description: 'View uncommitted changes and per-turn diffs',
  call: (...args) =>
    import('./diff.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command
