/**
 * Beta tracing is disabled in the OSS build.
 */

export interface Span {
  setAttribute(name: string, value: string | number | boolean): void
  setAttributes(attributes: Record<string, string | number | boolean>): void
  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void
  end(): void
  recordException(error: unknown): void
}

export interface LLMRequestNewContext {
  systemPrompt?: string
  querySource?: string
  tools?: string
}

export function clearBetaTracingState(): void {}

export function isBetaTracingEnabled(): boolean {
  return false
}
