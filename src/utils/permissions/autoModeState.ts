// Auto mode state functions — lives in its own module so callers can
// conditionally require() it on feature('TRANSCRIPT_CLASSIFIER').

let autoModeActive = false
let autoModeFlagCli = false

export function setAutoModeActive(active: boolean): void {
  autoModeActive = active
}

export function isAutoModeActive(): boolean {
  return autoModeActive
}

export function setAutoModeFlagCli(passed: boolean): void {
  autoModeFlagCli = passed
}

export function getAutoModeFlagCli(): boolean {
  return autoModeFlagCli
}

export function _resetForTesting(): void {
  autoModeActive = false
  autoModeFlagCli = false
}
