import type { Command } from '../../commands.js'

const keybindings = {
  name: 'keybindings',
  description: 'Open or create your keybindings configuration file',
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./keybindings.js'),
} satisfies Command

export default keybindings
