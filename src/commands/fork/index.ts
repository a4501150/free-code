import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'fork',
  description: 'Fork a subagent with full access',
  supportsNonInteractive: false,
  load: () => import('./fork.js'),
} satisfies Command
