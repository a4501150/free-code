import type { Command } from '../../commands.js'

const command = {
  name: 'vim',
  description: 'Toggle between Vim and Normal editing modes',
  supportsNonInteractive: false,
  type: 'local',
  call: (...args) =>
    import('./vim.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default command
