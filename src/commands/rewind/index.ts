import type { Command } from '../../commands.js'

const rewind = {
  description: `Restore the code and/or conversation to a previous point`,
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  call: (...args) =>
    import('./rewind.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default rewind
