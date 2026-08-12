import type { Command } from '../../commands.js'
import { getActiveOutputStyleNameSync } from '../../outputStyles/outputStyles.js'

export default {
  type: 'local-jsx',
  name: 'output-style',
  get description() {
    return `Set the output style shaping how Claude responds (currently ${getActiveOutputStyleNameSync()})`
  },
  argumentHint: '[style]',
  call: (...args) =>
    import('./output-style.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command
