import type { Command } from '../../commands.js'
import { checkCachedPassesEligibility } from '../../services/api/referral.js'

export default {
  type: 'local-jsx',
  name: 'passes',
  description: 'Share a free week of Claude Code with friends',
  get isHidden() {
    const { eligible, hasCache } = checkCachedPassesEligibility()
    return !eligible || !hasCache
  },
  call: (...args) =>
    import('./passes.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command
