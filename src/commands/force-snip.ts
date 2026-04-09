import type { Command } from '../commands.js'

export default {
  type: 'local',
  name: 'force-snip',
  description: 'Force-snip older conversation history',
  supportsNonInteractive: false,
  isHidden: true,
  async load() {
    return {
      call: async () => ({
        type: 'text' as const,
        value: 'History snipping is not available in this build.',
      }),
    }
  },
} satisfies Command
