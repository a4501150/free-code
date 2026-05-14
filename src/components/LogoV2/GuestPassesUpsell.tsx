import * as React from 'react'
import { Text } from '../../ink.js'

import {
  formatCreditAmount,
  getCachedReferrerReward,
} from '../../services/api/referral.js'

export function useShowGuestPassesUpsell(): boolean {
  return false
}

export function incrementGuestPassesSeenCount(): void {}

// Condensed layout for mini welcome screen
export function GuestPassesUpsell(): React.ReactNode {
  const reward = getCachedReferrerReward()
  return (
    <Text dimColor>
      <Text color="claude">[✻]</Text> <Text color="claude">[✻]</Text>{' '}
      <Text color="claude">[✻]</Text> ·{' '}
      {reward
        ? `Share Claude Code and earn ${formatCreditAmount(reward)} of extra usage · /passes`
        : '3 guest passes at /passes'}
    </Text>
  )
}
