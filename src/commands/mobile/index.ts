import type { Command } from '../../commands.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  description: 'Show QR code for the web interface',
  call: (...args) =>
    import('./mobile.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default mobile
