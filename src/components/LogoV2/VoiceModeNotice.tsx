import { feature } from 'bun:bundle'
import * as React from 'react'

export function VoiceModeNotice(): React.ReactNode {
  // Positive ternary pattern — see docs/feature-gating.md.
  // All strings must be inside the guarded branch for dead-code elimination.
  return feature('VOICE_MODE') ? <VoiceModeNoticeInner /> : null
}

function VoiceModeNoticeInner(): React.ReactNode {
  return null
}
