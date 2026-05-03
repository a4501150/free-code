import { feature } from 'bun:bundle'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'
import * as extractMemoriesNs from '../services/extractMemories/extractMemories.js'

const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? extractMemoriesNs
  : null

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import { cleanupOldMessageFilesInBackground } from './cleanup.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'

// 10 minutes after start.
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

export function startBackgroundHousekeeping(): void {
  void initMagicDocs()
  void initSkillImprovement()
  if (feature('EXTRACT_MEMORIES')) {
    extractMemoriesModule!.initExtractMemories()
  }
  initAutoDream()
  void autoUpdateMarketplacesAndPluginsInBackground()
  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      await cleanupOldMessageFilesInBackground()
    }

    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }
  }

  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()
}
