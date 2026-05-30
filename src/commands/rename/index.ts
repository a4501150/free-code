import type { Command } from '../../commands.js'

const rename = {
  type: 'local-jsx',
  name: 'rename',
  description: 'Rename the current conversation',
  immediate: true,
  argumentHint: '[name]',
  call: (...args) =>
    import('./rename.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default rename
