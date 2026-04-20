/**
 * Sandbox proxy-provider registry — leaf module.
 *
 * Breaks the sandbox-adapter → settings → changeDetector → hooks →
 * execHttpHook → sandbox-adapter cycle. sandbox-adapter registers its
 * SandboxManager as the provider at module init; execHttpHook reads via
 * getSandboxProxyProvider().
 */

export interface SandboxProxyProvider {
  isSandboxingEnabled(): boolean
  waitForNetworkInitialization(): Promise<boolean>
  getProxyPort(): number | undefined
}

let provider: SandboxProxyProvider | null = null

export function registerSandboxProxyProvider(p: SandboxProxyProvider): void {
  provider = p
}

export function getSandboxProxyProvider(): SandboxProxyProvider | null {
  return provider
}
