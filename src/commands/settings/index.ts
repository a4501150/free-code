import type { Command } from '../../commands.js'

// Same dialog as /config — /settings is the name users reach for first.
// The renderer lives in ../config/config.js to avoid a second copy.
const settings = {
  type: 'local-jsx',
  name: 'settings',
  description: 'Open the settings dialog',
  call: (...args) =>
    import('../config/config.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default settings
