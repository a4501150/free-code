import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from 'src/ink.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'

export function EmergencyTip(): React.ReactNode {
  const tip = useMemo(getTipOfFeed, [])

  if (!tip.tip) {
    return null
  }

  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text
        {...(tip.color === 'warning'
          ? { color: 'warning' }
          : tip.color === 'error'
            ? { color: 'error' }
            : { dimColor: true })}
      >
        {tip.tip}
      </Text>
    </Box>
  )
}

type TipOfFeed = {
  tip: string
  color?: 'dim' | 'warning' | 'error'
}

const DEFAULT_TIP: TipOfFeed = { tip: '', color: 'dim' }

function getTipOfFeed(): TipOfFeed {
  return getInitialSettings()?.emergencyTip ?? DEFAULT_TIP
}
