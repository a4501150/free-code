import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: 'View release notes',
  name: 'release-notes',
  type: 'local',
  supportsNonInteractive: true,
  call: (...args) =>
    import('./release-notes.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
}

export default releaseNotes
