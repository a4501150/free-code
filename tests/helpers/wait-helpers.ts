export type WaitForOptions = {
  timeoutMs?: number
  intervalMs?: number
  description?: string
  onTimeout?: () => Promise<string> | string
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  isReady: (value: T) => boolean,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
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
  const details = [
    `Timed out waiting for ${description} after ${timeoutMs}ms.`,
    lastError ? `Last error: ${formatError(lastError)}` : undefined,
    lastValue !== undefined
      ? `Last value: ${formatValue(lastValue)}`
      : undefined,
    diagnostics,
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
    return String(value)
  }
}
