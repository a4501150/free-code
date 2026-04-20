/**
 * Built-in command names registry — leaf module.
 *
 * Breaks the sessionStorage → commands cycle. commands.ts registers its
 * builtInCommandNames at module init; sessionStorage.ts reads via
 * getBuiltInCommandNames().
 */

type Provider = () => Set<string>

let provider: Provider = () => new Set<string>()

export function registerCommandNames(p: Provider): void {
  provider = p
}

export function getBuiltInCommandNames(): Set<string> {
  return provider()
}
