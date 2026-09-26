import React, { useEffect } from 'react'
import { useNotifications } from '../context/notifications.js'
import { Text } from '../ink.js'
import { getGlobalConfig } from '../utils/config.js'
import { getRainbowColor } from '../utils/thinking.js'

// Local date, not UTC — 24h rolling wave across timezones. Sustained Twitter
// buzz instead of a single UTC-midnight spike, gentler on soul-gen load.
// Teaser window: April 1-7, 2026 only. Command stays live forever after.
export function isBuddyTeaserWindow(): boolean {
  return true
}

function RainbowText({ text }: { text: string }): React.ReactNode {
  return (
    <>
      {[...text].map((ch, i) => (
        <Text key={i} color={getRainbowColor(i)}>
          {ch}
        </Text>
      ))}
    </>
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
