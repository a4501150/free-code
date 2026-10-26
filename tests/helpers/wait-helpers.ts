import { cpus, loadavg } from 'os'

export type WaitForOptions = {
  timeoutMs?: number
  intervalMs?: number
  description?: string
  onTimeout?: () => Promise<string> | string
}

/**
 * Paint/boot budgets are calibrated for an idle machine; a saturated box
 * takes proportionally longer for the same work, so scale the budget by
 * saturation (capped at 3x) instead of inflating per-test constants. At or
 * below one busy core the configured budget stands.
 */
export function loadScaledTimeoutMs(baseMs: number): number {
  const cores = cpus().length || 1
  const saturation = loadavg()[0] / cores
  return Math.round(baseMs * Math.min(3, Math.max(1, saturation)))
}

/**
 * Harness-supplied context appended to every timeout message — e.g. the
 * mock server's request log, which turns a stuck-turn timeout into a
 * named queue gap. Registration returns the unregister function.
 */
type TimeoutDiagnosticsProvider = () => string | Promise<string>
const timeoutDiagnosticsProviders: TimeoutDiagnosticsProvider[] = []

export function registerTimeoutDiagnostics(
  provider: TimeoutDiagnosticsProvider,
): () => void {
  timeoutDiagnosticsProviders.push(provider)
  return () => {
    const idx = timeoutDiagnosticsProviders.indexOf(provider)
    if (idx !== -1) timeoutDiagnosticsProviders.splice(idx, 1)
  }
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  isReady: (value: T) => boolean,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = loadScaledTimeoutMs(options.timeoutMs ?? 30_000)
  const intervalMs = options.intervalMs ?? 100
  const description = options.description ?? 'condition'
  const start = performance.now()
  let lastValue: T | undefined
  let lastError: unknown

  while (performance.now() - start < timeoutMs) {
    try {
      const value = await probe()
      lastValue = value
      lastError = undefined
      if (isReady(value)) {
        return value
      }
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }

  const diagnostics = options.onTimeout ? await options.onTimeout() : undefined
  const harnessDiagnostics = await Promise.all(
    timeoutDiagnosticsProviders.map(provider =>
      Promise.resolve()
        .then(provider)
        .catch(error => `(diagnostics provider failed: ${String(error)})`),
    ),
  )
  const details = [
    `Timed out waiting for ${description} after ${timeoutMs}ms.`,
    lastError ? `Last error: ${formatError(lastError)}` : undefined,
    lastValue !== undefined
      ? `Last value: ${formatValue(lastValue)}`
      : undefined,
    diagnostics,
    ...harnessDiagnostics,
  ].filter(Boolean)

  throw new Error(details.join('\n'))
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value
  }

  try {
    const json = JSON.stringify(value)
    return json.length > 1_000 ? `${json.slice(0, 1_000)}…` : json
  } catch {
    return String(error)
  }
}
