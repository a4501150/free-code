import type { Command } from '../../commands.js'
import {
  isVoiceModeFeatureEnabled,
  isVoiceModeEnabled,
} from '../../voice/voiceModeEnabled.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'Toggle voice mode',
  availability: ['claude-ai'],
  isEnabled: () => isVoiceModeFeatureEnabled(),
  get isHidden() {
    return !isVoiceModeEnabled()
  },
  supportsNonInteractive: false,
  call: (...args) =>
    import('./voice.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default voice
