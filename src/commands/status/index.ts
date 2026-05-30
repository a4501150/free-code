import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    'Show Claude Code status including version, model, account, API connectivity, and tool statuses',
  immediate: true,
  call: (...args) =>
    import('./status.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default status
