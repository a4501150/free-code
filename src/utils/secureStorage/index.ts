import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * Get the appropriate secure storage implementation for the current platform
 */
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }

  // Plaintext is the deliberate cross-platform store, not a missing
  // libsecret integration: credentials live in <config home>/.credentials.json
  // mode 0600, and plaintext storage is an explicit product decision here
  // (no keyring dependency across Linux distros/containers/headless CI).
  // macOS additionally gets the Keychain below, with plaintext as fallback.
  return plainTextStorage
}
