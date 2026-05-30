import type { Command } from '../../commands.js'
import { isConsumerSubscriber } from '../../utils/auth.js'

const privacySettings = {
  type: 'local-jsx',
  name: 'privacy-settings',
  description: 'View and update your privacy settings',
  isEnabled: () => {
    return isConsumerSubscriber()
  },
  call: (...args) =>
    import('./privacy-settings.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default privacySettings
