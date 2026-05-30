import type { Command } from '../../commands.js'

const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: 'List available skills',
  call: (...args) =>
    import('./skills.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default skills
