import type { Command } from '../../commands.js'

const btw = {
  type: 'local-jsx',
  name: 'btw',
  description:
    'Ask a quick side question without interrupting the main conversation',
  immediate: true,
  argumentHint: '<question>',
  call: (...args) =>
    import('./btw.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default btw
