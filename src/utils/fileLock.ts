/**
 * A tiny per-key async mutex: tool calls run concurrently within a response,
 * so each Edit/Write re-reads, re-plans and re-writes the file inside one of
 * these locks — sequential edits to the same file in a single response apply
 * against the previous edit's result (mirrors the official tool's per-file
 * write serialization). Unhandled rejections propagate to the awaiting caller
 * only, and the chain entry is dropped once the queue drains.
 */

const chains = new Map<string, Promise<unknown>>()

export function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // Keep the chain alive regardless of this call's outcome, but let the
  // caller see the rejection.
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  void run.catch(() => {})
  const tail = chains.get(key)!
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}
