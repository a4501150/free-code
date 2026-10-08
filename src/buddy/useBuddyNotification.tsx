import React, { useEffect } from 'react'
import { useNotifications } from '../context/notifications.js'
import { Box, useAnimationFrame } from '../ink.js'
import { ShimmerChar } from '../components/Spinner/ShimmerChar.js'
import { getGlobalConfig } from '../utils/config.js'
import { getRainbowColor } from '../utils/thinking.js'
import { getInitialSettings } from '../utils/settings/settings.js'

// Local date, not UTC — 24h rolling wave across timezones. Sustained Twitter
// buzz instead of a single UTC-midnight spike, gentler on soul-gen load.
// Teaser window: April 1-7, 2026 only. Command stays live forever after.
export function isBuddyTeaserWindow(): boolean {
  return true
}

// Same shimmer sweep as the /buddy highlight in the prompt input
// (ShimmeredInput): a bright glimmer travels across the rainbow text at
// 50ms/frame with an offscreen pause between sweeps.
const SHIMMER_FRAME_MS = 50
const SHIMMER_PADDING = 10

function RainbowText({ text }: { text: string }): React.ReactNode {
  const reducedMotion = getInitialSettings().prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : SHIMMER_FRAME_MS)
  const chars = [...text]
  const cycleLength = chars.length + SHIMMER_PADDING * 2
  const glimmerIndex = reducedMotion
    ? -100
    : -SHIMMER_PADDING + (Math.floor(time / SHIMMER_FRAME_MS) % cycleLength)

  return (
    <Box ref={ref}>
      {chars.map((ch, i) => (
        <ShimmerChar
          key={i}
          char={ch}
          index={i}
          glimmerIndex={glimmerIndex}
          messageColor={getRainbowColor(i)}
          shimmerColor={getRainbowColor(i, true)}
        />
      ))}
    </Box>
  )
}

// Rainbow /buddy teaser shown on startup when no companion hatched yet.
// Idle presence and reactions are handled by CompanionSprite directly.
export function useBuddyNotification(): void {
  const { addNotification, removeNotification } = useNotifications()

  useEffect(() => {
    const config = getGlobalConfig()
    if (config.companion || !isBuddyTeaserWindow()) return
    addNotification({
      key: 'buddy-teaser',
      jsx: <RainbowText text="/buddy" />,
      priority: 'immediate',
      timeoutMs: 15_000,
    })
    return () => removeNotification('buddy-teaser')
  }, [addNotification, removeNotification])
}
