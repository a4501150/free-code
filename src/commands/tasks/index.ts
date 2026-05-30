import type { Command } from '../../commands.js'

const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  aliases: ['bashes'],
  description: 'List and manage background tasks',
  call: (...args) =>
    import('./tasks.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default tasks
