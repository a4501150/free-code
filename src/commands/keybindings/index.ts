import type { Command } from '../../commands.js'

const keybindings = {
  name: 'keybindings',
  description: 'Open or create your keybindings configuration file',
  supportsNonInteractive: false,
  type: 'local',
  call: (...args) =>
    import('./keybindings.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default keybindings
