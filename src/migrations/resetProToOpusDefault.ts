
import { isProSubscriber } from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getProviderRegistry } from '../utils/model/providerRegistry.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

export function resetProToOpusDefault(): void {
  const config = getGlobalConfig()

  if (config.opusProMigrationComplete) {
    return
  }

  // Pro users on firstParty get auto-migrated to Opus 4.5 default
  if (!getProviderRegistry().getCapabilities().firstPartyFeatures || !isProSubscriber()) {
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
    }))
    return
  }

  const settings = getSettings_DEPRECATED()

  // Only show notification if user was on default (no custom model setting)
  if (settings?.model === undefined) {
    const opusProMigrationTimestamp = Date.now()
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
      opusProMigrationTimestamp,
    }))
  } else {
    // User has a custom model setting, just mark migration complete
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
    }))
  }
}
