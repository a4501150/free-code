import type { Command } from '../../commands.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  aliases: ['fork'],
  description: 'Create a branch of the current conversation at this point',
  argumentHint: '[name]',
  call: (...args) =>
    import('./branch.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default branch
