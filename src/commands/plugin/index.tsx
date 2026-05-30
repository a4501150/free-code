import type { Command } from '../../commands.js'

const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Manage Claude Code plugins',
  immediate: true,
  call: (...args) =>
    import('./plugin.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default plugin
