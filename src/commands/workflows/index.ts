import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'workflows',
  description: 'List and manage workflow scripts',
  supportsNonInteractive: false,
  load: () => import('./workflows.js'),
} satisfies Command
