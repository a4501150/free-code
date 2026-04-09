import type { Command } from '../../commands.js'

const buddy = {
  type: 'local',
  name: 'buddy',
  description: 'Manage your companion',
  isEnabled: () => true,
  supportsNonInteractive: false,
  argumentHint: '[info|pet|mute|unmute]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
