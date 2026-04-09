/**
 * Reactive (trigger-based) automatic compaction.
 * Stub — the real implementation is not available in this build.
 */

export function isReactiveOnlyMode(): boolean {
  return false
}

export function isReactiveCompactEnabled(): boolean {
  return false
}

export function isWithheldPromptTooLong(_message: unknown): boolean {
  return false
}

export function isWithheldMediaSizeError(_message: unknown): boolean {
  return false
}

export async function reactiveCompactOnPromptTooLong(
  _messages: unknown[],
  _cacheSafeParams: unknown,
  _options: { customInstructions?: string; trigger: string },
): Promise<{
  ok: false
  reason: 'aborted'
  result: Record<string, unknown>
}> {
  return { ok: false, reason: 'aborted', result: {} }
}

export async function tryReactiveCompact(
  _params: Record<string, unknown>,
): Promise<null> {
  return null
}
