import type { Command } from '../../commands.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: 'Manage allow & deny tool permission rules',
  call: (...args) =>
    import('./permissions.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default permissions
