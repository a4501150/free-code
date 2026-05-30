import type { Command } from '../../commands.js'

const exportCommand = {
  type: 'local-jsx',
  name: 'export',
  description: 'Export the current conversation to a file or clipboard',
  argumentHint: '[filename]',
  call: (...args) =>
    import('./export.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default exportCommand
