import { companionUserId, getCompanion, roll } from '../../buddy/companion.js'
import { RARITY_STARS } from '../../buddy/types.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export const call: LocalCommandCall = async args => {
  const sub = (args || 'info').trim().toLowerCase()

  switch (sub) {
    case 'mute': {
      saveGlobalConfig(config => ({ ...config, companionMuted: true }))
      return { type: 'text', value: 'Companion muted.' }
    }

    case 'unmute': {
      saveGlobalConfig(config => ({ ...config, companionMuted: false }))
      return { type: 'text', value: 'Companion unmuted.' }
    }

    case 'pet': {
      const companion = getCompanion()
      if (!companion) {
        return {
          type: 'text',
          value: 'No companion yet. Run /buddy to see your egg!',
        }
      }
      return {
        type: 'text',
        value: `You pet ${companion.name}. ${companion.name} seems happy!`,
      }
    }

    case 'info':
    default: {
      const companion = getCompanion()
      if (!companion) {
        const userId = companionUserId()
        const { bones } = roll(userId)
        const lines = [
          'You have an unhatched egg!',
          `Species: ${bones.species}`,
          `Rarity: ${bones.rarity} ${RARITY_STARS[bones.rarity]}`,
          '',
          'Your companion will hatch when given a name and personality.',
        ]
        return { type: 'text', value: lines.join('\n') }
      }

      const statLines = Object.entries(companion.stats)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join('\n')

      const lines = [
        `${companion.name} the ${companion.species}`,
        `Rarity: ${companion.rarity} ${RARITY_STARS[companion.rarity]}`,
        `Eye: ${companion.eye}  Hat: ${companion.hat}${companion.shiny ? '  ✨ SHINY' : ''}`,
        `Personality: ${companion.personality}`,
        '',
        'Stats:',
        statLines,
      ]
      return { type: 'text', value: lines.join('\n') }
    }
  }
}
