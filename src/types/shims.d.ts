// Ambient module declarations for dependencies that ship no type definitions.
// When these packages eventually publish types, remove the corresponding entry.

declare module 'asciichart'
declare module 'bidi-js'

declare module 'proper-lockfile' {
  export type LockOptions = {
    stale?: number
    update?: number
    retries?: number | object
    realpath?: boolean
    fs?: unknown
    onCompromised?: (err: Error) => void
    lockfilePath?: string
  }
  export type UnlockOptions = {
    realpath?: boolean
    fs?: unknown
    lockfilePath?: string
  }
  export type CheckOptions = {
    stale?: number
    realpath?: boolean
    fs?: unknown
    lockfilePath?: string
  }
  export function lock(
    file: string,
    options?: LockOptions,
  ): Promise<() => Promise<void>>
  export function lockSync(
    file: string,
    options?: LockOptions,
  ): () => void
  export function unlock(
    file: string,
    options?: UnlockOptions,
  ): Promise<void>
  export function unlockSync(file: string, options?: UnlockOptions): void
  export function check(
    file: string,
    options?: CheckOptions,
  ): Promise<boolean>
  export function checkSync(file: string, options?: CheckOptions): boolean
}
