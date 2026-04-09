import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'peers',
  description: 'List active Claude Code sessions on this machine',
  supportsNonInteractive: false,
  load: () => import('./peers.js'),
} satisfies Command
