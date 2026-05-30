import type { Command } from '../../commands.js'

const files = {
  type: 'local',
  name: 'files',
  description: 'List all files currently in context',
  isEnabled: () => true,
  supportsNonInteractive: true,
  call: (...args) =>
    import('./files.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default files
