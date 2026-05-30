import type { Command } from '../../commands.js'

const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: 'Change the theme',
  call: (...args) =>
    import('./theme.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default theme
