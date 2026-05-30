import type { Command } from '../../commands.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Show help and available commands',
  call: (...args) =>
    import('./help.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default help
