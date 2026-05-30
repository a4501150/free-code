import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Edit Claude memory files',
  call: (...args) =>
    import('./memory.js').then(mod => Reflect.apply(mod.call, undefined, args)),
}

export default memory
