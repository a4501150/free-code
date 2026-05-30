import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasAnthropicApiKeyAuth()
      ? 'Switch accounts or configure provider auth'
      : 'Sign in with your account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    call: (...args) =>
      import('./login.js').then(mod =>
        Reflect.apply(mod.call, undefined, args),
      ),
  }) satisfies Command
