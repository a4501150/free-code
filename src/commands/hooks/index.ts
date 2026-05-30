import type { Command } from '../../commands.js'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: 'View hook configurations for tool events',
  immediate: true,
  call: (...args) =>
    import('./hooks.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default hooks
