import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show plan usage limits',
  availability: ['claude-ai'],
  call: (...args) =>
    import('./usage.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command
