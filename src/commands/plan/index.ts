import type { Command } from '../../commands.js'

const plan = {
  type: 'local-jsx',
  name: 'plan',
  description: 'Enable plan mode or view the current session plan',
  argumentHint: '[open|<description>]',
  call: (...args) =>
    import('./plan.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default plan
