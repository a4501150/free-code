import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from '../components/CustomSelect/index.js'
import { Dialog } from '../components/design-system/Dialog.js'
import { useSetAppState } from '../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import type { Theme } from '../utils/theme.js'
import { getCompanion } from './companion.js'
import { renderSprite } from './sprites.js'
import { RARITY_COLORS, RARITY_STARS, STAT_NAMES } from './types.js'

const BAR_WIDTH = 10

export function StatBars({
  stats,
  color,
}: {
  stats: Record<(typeof STAT_NAMES)[number], number>
  color: keyof Theme
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {STAT_NAMES.map(name => {
        const value = stats[name]
        const filled = Math.round((value / 100) * BAR_WIDTH)
        return (
          <Box key={name}>
            <Text dimColor>{name.padEnd(10)}</Text>
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text dimColor>
              {'░'.repeat(BAR_WIDTH - filled)} {String(value).padStart(3)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

type MenuAction = 'pet' | 'mute' | 'unmute' | 'close'

export function BuddyMenu({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const companion = getCompanion()
  const setAppState = useSetAppState()
  const [muted, setMuted] = useState(
    () => getGlobalConfig().companionMuted ?? false,
  )

  if (!companion) {
    onDone('No companion yet. Run /buddy to see your egg!', {
      display: 'system',
    })
    return null
  }

  const color = RARITY_COLORS[companion.rarity]
  const shiny = companion.shiny ? '  ✨ SHINY' : ''
  const companionName = companion.name

  function handleAction(action: MenuAction): void {
    switch (action) {
      case 'pet':
        setAppState(prev => ({ ...prev, companionPetAt: Date.now() }))
        onDone(`You pet ${companionName}. ${companionName} seems happy!`)
        return
      case 'mute':
        saveGlobalConfig(prev => ({ ...prev, companionMuted: true }))
        setMuted(true)
        return
      case 'unmute':
        saveGlobalConfig(prev => ({ ...prev, companionMuted: false }))
        setMuted(false)
        return
      case 'close':
        onDone('Companion menu closed.', { display: 'system' })
        return
    }
  }

  const options: { label: string; value: MenuAction }[] = [
    { label: `Pet ${companion.name}`, value: 'pet' },
    muted
      ? { label: 'Unmute companion', value: 'unmute' }
      : { label: 'Mute companion', value: 'mute' },
    { label: 'Close', value: 'close' },
  ]

  return (
    <Dialog
      title={`${companion.name} the ${companion.species}`}
      subtitle={`${companion.rarity} ${RARITY_STARS[companion.rarity]}  eye ${companion.eye}  hat ${companion.hat}${shiny}${muted ? '  (muted)' : ''}`}
      color={color}
      onCancel={() => onDone('Companion menu closed.', { display: 'system' })}
    >
      <Box gap={2}>
        <Box flexDirection="column">
          {renderSprite(companion, 0).map((line, i) => (
            <Text key={i} color={color}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" gap={1}>
          <Text italic dimColor>
            {companion.personality}
          </Text>
          <StatBars stats={companion.stats} color={color} />
        </Box>
      </Box>
      <Select
        options={options}
        onChange={handleAction}
        onCancel={() => onDone('Companion menu closed.', { display: 'system' })}
      />
    </Dialog>
  )
}
