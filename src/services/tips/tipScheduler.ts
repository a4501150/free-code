import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { getNextRoundRobinIndex } from './tipHistory.js'
import { getRelevantTips } from './tipRegistry.js'
import type { Tip, TipContext } from './types.js'

export async function getTipToShowOnSpinner(
  context?: TipContext,
): Promise<Tip | undefined> {
  if (getSettings_DEPRECATED().spinnerTipsEnabled === false) {
    return undefined
  }

  const tips = await getRelevantTips(context)
  if (tips.length === 0) {
    return undefined
  }

  return tips[getNextRoundRobinIndex(tips.length)]
}
