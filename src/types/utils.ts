/**
 * Generic utility types shared across the codebase.
 */

/**
 * Recursive readonly — turns every nested property of T into readonly, and
 * every nested array into a ReadonlyArray.
 *
 * Used to freeze types like AppState, task snapshots, and message slices
 * that must not be mutated by consumers.
 */
export type DeepImmutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepImmutable<U>>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepImmutable<U>>
        : T extends object
          ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
          : T

/**
 * Tuple-union of every permutation of T.
 *
 * Used with `satisfies` to assert a literal tuple covers every member of a
 * string union exactly once — e.g. `[...] satisfies Permutations<Mode>`
 * would fail to type-check if a mode were added without being listed.
 */
export type Permutations<T, U = T> = [T] extends [never]
  ? []
  : T extends U
    ? [T, ...Permutations<Exclude<U, T>>]
    : never
