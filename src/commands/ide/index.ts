import type { Command } from '../../commands.js'

const ide = {
  type: 'local-jsx',
  name: 'ide',
  description: 'Manage IDE integrations and show status',
  argumentHint: '[open]',
  call: (...args) =>
    import('./ide.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default ide
