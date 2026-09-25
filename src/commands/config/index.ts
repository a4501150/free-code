import type { Command } from '../../commands.js'

const config = {
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  call: (...args) =>
    import('./config.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default config
