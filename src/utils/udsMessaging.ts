/**
 * Unix Domain Socket messaging for cross-session communication.
 * Stub — the real implementation is not available in this build.
 */

let _socketPath = ''

export async function startUdsMessaging(
  _socketPath: string,
  _opts: { isExplicit: boolean },
): Promise<void> {}

export function getDefaultUdsSocketPath(): string {
  return ''
}

export function getUdsMessagingSocketPath(): string {
  return _socketPath
}

export function setOnEnqueue(_callback: () => void): void {}
