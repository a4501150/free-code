import type { Command } from '../../commands.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: 'Your 2025 Claude Code Year in Review',
  isEnabled: () => true,
  call: (...args) =>
    import('./thinkback.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default thinkback
