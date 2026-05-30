import type { Command } from '../../commands.js'

const buddy = {
  type: 'local',
  name: 'buddy',
  description: 'Manage your companion',
  isEnabled: () => true,
  supportsNonInteractive: false,
  argumentHint: '[info|pet|mute|unmute]',
  call: (...args) =>
    import('./buddy.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default buddy
