import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * The single credential backend on every platform: plaintext
 * <config home>/.credentials.json, mode 0600.
 *
 * This is a deliberate product decision, not a missing keyring integration:
 * no keychain/keyring dependency across distros, containers, and headless
 * CI, and no un-timed blocking subprocess on the startup path (a macOS
 * `security` spawn waiting on an ACL dialog used to wedge `cli -p`
 * indefinitely). The macOS keychain is read exactly once, as a copy source
 * for the one-shot import in keychainMigration.ts.
 */
export function getSecureStorage(): SecureStorage {
  return plainTextStorage
}
