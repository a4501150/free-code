/**
 * Abort-responsive sleep. Resolves after `ms` milliseconds, or immediately
 * when `signal` aborts (so backoff loops don't block shutdown).
 *
 * By default, abort resolves silently; the caller should check
 * `signal.aborted` after the await. Pass `throwOnAbort: true` to have
 * abort reject — useful when the sleep is deep inside a retry loop
 * and you want the rejection to bubble up and cancel the whole operation.
 *
 * Pass `abortError` to customize the rejection error (implies
 * `throwOnAbort: true`). Useful for retry loops that catch a specific
 * error class (e.g. `APIUserAbortError`).
 */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  opts?: { throwOnAbort?: boolean; abortError?: () => Error; unref?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check aborted state BEFORE setting up the timer. If we defined
    // onAbort first and called it synchronously here, it would reference
    // `timer` while still in the Temporal Dead Zone.
    if (signal?.aborted) {
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error('aborted'))
      } else {
        void resolve()
      }
      return
    }
    const timer = setTimeout(
      (signal, onAbort, resolve) => {
        signal?.removeEventListener('abort', onAbort)
        void resolve()
      },
      ms,
      signal,
      onAbort,
      resolve,
    )
    function onAbort(): void {
      clearTimeout(timer)
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error('aborted'))
      } else {
        void resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (opts?.unref) {
      timer.unref()
    }
  })
}

function rejectWithTimeout(reject: (e: Error) => void, message: string): void {
  reject(new Error(message))
}
