import type { Command } from '../../commands.js'

const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: 'Manage agent configurations',
  call: (...args) =>
    import('./agents.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default agents
