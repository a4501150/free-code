import type { Command } from '../../commands.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: 'Show QR code to download the Claude mobile app',
  call: (...args) =>
    import('./mobile.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default mobile
