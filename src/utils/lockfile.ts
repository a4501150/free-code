/**
 * Thin re-export wrapper over proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). We now pay that cost unconditionally at
 * startup — the lazy import pattern this file used to implement was the
 * exact kind of runtime indirection this refactor is removing.
 */

export { lock, lockSync, unlock, check } from 'proper-lockfile'
