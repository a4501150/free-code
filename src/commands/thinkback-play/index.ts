import type { Command } from '../../commands.js'

// Hidden command that just plays the animation
// Called by the thinkback skill after generation is complete
const thinkbackPlay = {
  type: 'local',
  name: 'thinkback-play',
  description: 'Play the thinkback animation',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: false,
  call: (...args) =>
    import('./thinkback-play.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default thinkbackPlay
