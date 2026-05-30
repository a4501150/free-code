import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description: 'Sign out from your account',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  call: (...args) =>
    import('./logout.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command
