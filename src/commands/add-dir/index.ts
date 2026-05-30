import type { Command } from '../../commands.js'

const addDir = {
  type: 'local-jsx',
  name: 'add-dir',
  description: 'Add a new working directory',
  argumentHint: '<path>',
  call: (...args) =>
    import('./add-dir.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default addDir
