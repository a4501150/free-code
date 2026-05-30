import type { Command } from '../../commands.js'

const tag = {
  type: 'local-jsx',
  name: 'tag',
  description: 'Toggle a searchable tag on the current session',
  isEnabled: () => true,
  argumentHint: '<tag-name>',
  call: (...args) =>
    import('./tag.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default tag
