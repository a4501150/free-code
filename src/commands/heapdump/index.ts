import type { Command } from '../../commands.js'

const heapDump = {
  type: 'local',
  name: 'heapdump',
  description: 'Dump the JS heap to ~/Desktop',
  isHidden: true,
  supportsNonInteractive: true,
  call: (...args) =>
    import('./heapdump.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default heapDump
