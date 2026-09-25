import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from '../components/CustomSelect/index.js'
import { Dialog } from '../components/design-system/Dialog.js'
import { Box, Text } from '../ink.js'
import type { CompanionBones, CompanionSoul } from './types.js'
import { RARITY_COLORS, RARITY_STARS } from './types.js'
import { generateSoul } from './soul.js'
import { renderSprite } from './sprites.js'
import { StatBars } from './BuddyMenu.js'
import { saveGlobalConfig } from '../utils/config.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'

// Egg shell with the unborn companion's eyes peeking through.
function eggArt(eye: string, shiny: boolean): string[] {
  return [
    shiny ? '  *   .---. ' : '    .---.   ',
    '   /    \\  ',
    `   / ${eye} ${eye} \\  `,
    '  (   _   )',
    '  (       )',
    '   \\ ~~~ / ',
    '   `-=-´   ',
  ]
}

type Phase =
  | { kind: 'egg' }
  | { kind: 'wobbling' }
  | { kind: 'preview'; soul: CompanionSoul }

export function BuddyHatchDialog({
  onDone,
  bones,
  seed,
}: {
  onDone: LocalJSXCommandOnDone
  bones: CompanionBones
  seed: number
}): React.ReactNode {
  const color = RARITY_COLORS[bones.rarity]
  const [phase, setPhase] = useState<Phase>({ kind: 'egg' })
  const [attempts, setAttempts] = useState(0)
  const abortRef = useRef(new AbortController())
  useEffect(() => {
    const ac = abortRef.current
    return () => ac.abort()
  }, [])

  async function hatch(note: string | undefined): Promise<void> {
    setPhase({ kind: 'wobbling' })
    const soul = await generateSoul(bones, seed, note, abortRef.current.signal)
    setPhase({ kind: 'preview', soul })
  }

  function confirm(soul: CompanionSoul): void {
    saveGlobalConfig(prev => ({
      ...prev,
      companion: {
        name: soul.name,
        personality: soul.personality,
        hatchedAt: Date.now(),
      },
    }))
    onDone(
      `${soul.name} the ${bones.species} has hatched! It settled in beside your prompt box.`,
    )
  }

  const cancel = (): void => {
    onDone('The egg stays unhatched. /buddy again whenever.', {
      display: 'system',
    })
  }

  const title =
    phase.kind === 'preview'
      ? `A ${bones.rarity} ${bones.species} is stirring...`
      : 'A wild egg appears!'

  return (
    <Dialog
      title={title}
      subtitle={`Rarity: ${bones.rarity} ${RARITY_STARS[bones.rarity]}`}
      color={color}
      onCancel={cancel}
    >
      {phase.kind !== 'preview' && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {eggArt(bones.eye, bones.shiny).map((line, i) => (
              <Text key={i} color={color}>
                {line}
              </Text>
            ))}
          </Box>
          {phase.kind === 'wobbling' ? (
            <Text italic dimColor>
              The egg wobbles...
            </Text>
          ) : (
            <Box gap={2}>
              <Box flexDirection="column">
                <Text>
                  Species: {bones.species} Hat: {bones.hat}
                  {bones.shiny ? '  ✨ shiny' : ''}
                </Text>
                <Text dimColor>Something inside already has opinions.</Text>
              </Box>
              <StatBars stats={bones.stats} color={color} />
            </Box>
          )}
        </Box>
      )}
      {phase.kind === 'preview' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={2}>
            <Box flexDirection="column">
              {renderSprite(bones, 0).map((line, i) => (
                <Text key={i} color={color}>
                  {line}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column" gap={1}>
              <Text bold color={color}>
                {phase.soul.name}
              </Text>
              <Text italic dimColor>
                {phase.soul.personality}
              </Text>
            </Box>
          </Box>
        </Box>
      )}
      {phase.kind === 'egg' && (
        <Select
          options={[
            { label: 'Hatch it', value: 'hatch' },
            { label: 'Not yet', value: 'cancel' },
          ]}
          onChange={value => {
            if (value === 'hatch') void hatch(undefined)
            else cancel()
          }}
          onCancel={cancel}
        />
      )}
      {phase.kind === 'preview' && (
        <Select
          options={[
            { label: `Welcome, ${phase.soul.name}`, value: 'confirm' },
            { label: 'Re-roll the soul', value: 'reroll' },
            { label: 'Back to the egg', value: 'cancel' },
          ]}
          onChange={value => {
            if (value === 'confirm') confirm(phase.soul)
            else if (value === 'reroll') {
              const n = attempts + 1
              setAttempts(n)
              void hatch(`this is take ${n + 1}, pick a clearly different vibe`)
            } else cancel()
          }}
          onCancel={cancel}
        />
      )}
    </Dialog>
  )
}
