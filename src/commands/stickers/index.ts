import type { Command } from '../../commands.js'

const stickers = {
  type: 'local',
  name: 'stickers',
  description: 'Order Claude Code stickers',
  supportsNonInteractive: false,
  call: (...args) =>
    import('./stickers.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default stickers
