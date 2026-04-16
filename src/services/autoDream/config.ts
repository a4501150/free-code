// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Whether background memory consolidation should run.
 * Controlled by autoDreamEnabled in freecode.json (default: false).
 */
export function isAutoDreamEnabled(): boolean {
  return getInitialSettings().autoDreamEnabled ?? false
}
