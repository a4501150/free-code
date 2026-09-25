import * as React from 'react'
import { companionUserId, getCompanion, roll } from '../../buddy/companion.js'
import { BuddyHatchDialog } from '../../buddy/BuddyHatchDialog.js'
import { BuddyMenu } from '../../buddy/BuddyMenu.js'
import { RARITY_STARS } from '../../buddy/types.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

function infoText(): string {
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
      'Run /buddy to hatch it.',
    ]
    return lines.join('\n')
  }

  const statLines = Object.entries(companion.stats)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join('\n')

  const lines = [
    `${companion.name} the ${companion.species}`,
    `Rarity: ${companion.rarity} ${RARITY_STARS[companion.rarity]}`,
    `Eye: ${companion.eye}  Hat: ${companion.hat}${companion.shiny ? '  ✨ SHINY' : ''}`,
    `Personality: ${companion.personality}`,
    getGlobalConfig().companionMuted ? 'Companion is muted.' : '',
    '',
    'Stats:',
    statLines,
  ]
  return lines.join('\n')
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const sub = (args || '').trim().toLowerCase()

  switch (sub) {
    case 'mute': {
      saveGlobalConfig(config => ({ ...config, companionMuted: true }))
      onDone('Companion muted.')
      return null
    }

    case 'unmute': {
      saveGlobalConfig(config => ({ ...config, companionMuted: false }))
      onDone('Companion unmuted.')
      return null
    }

    case 'pet': {
      const companion = getCompanion()
      if (!companion) {
        onDone('No companion yet. Run /buddy to see your egg!', {
          display: 'system',
        })
        return null
      }
      // Fires the hearts burst on the ambient sprite; AppState is the only
      // channel from command code to the footer.
      context.setAppState(prev => ({ ...prev, companionPetAt: Date.now() }))
      onDone(`You pet ${companion.name}. ${companion.name} seems happy!`)
      return null
    }

    case 'info': {
      onDone(infoText())
      return null
    }

    default: {
      const companion = getCompanion()
      if (!companion) {
        const { bones, inspirationSeed } = roll(companionUserId())
        return (
          <BuddyHatchDialog
            onDone={onDone}
            bones={bones}
            seed={inspirationSeed}
          />
        )
      }
      return <BuddyMenu onDone={onDone} />
    }
  }
}
