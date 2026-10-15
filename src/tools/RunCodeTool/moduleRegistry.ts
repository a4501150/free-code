// Bundled packages exposed to RunCode scripts. `bun build --packages bundle`
// already ships these inside the binary, but a compiled binary cannot resolve
// bare specifiers from disk at runtime (and a dev run would silently resolve
// them from the repo's node_modules), so the loader hands scripts these live
// namespaces instead. Add a package by importing it and adding one entry.

import * as zod from 'zod'
import * as yaml from 'yaml'
import * as jsoncParser from 'jsonc-parser/lib/esm/main.js'
import * as picomatch from 'picomatch'
import * as semver from 'semver'
import * as marked from 'marked'
import * as lodashEs from 'lodash-es'

import type { NamespaceResolution } from './loader.js'

const MODULES: Record<string, Record<string, unknown>> = {
  zod,
  yaml,
  'jsonc-parser': jsoncParser,
  picomatch,
  semver,
  marked,
  'lodash-es': lodashEs,
}

export const RUN_CODE_MODULE_SPECS = Object.keys(MODULES)

export function resolveRunCodeModule(spec: string): NamespaceResolution {
  const ns = MODULES[spec]
  if (ns) return { ok: true, ns, exports: Object.keys(ns) }
  return {
    ok: false,
    error: `Module "${spec}" is not available to scripts. Bundled modules: ${RUN_CODE_MODULE_SPECS.join(
      ', ',
    )}.`,
  }
}

/**
 * Wraps the catalog namespace resolver so static imports of bundled modules
 * fall through to the registry, and unknown bare specifiers get a hint that
 * names what is actually available.
 */
export function withModuleFallback(
  base: (spec: string) => NamespaceResolution,
): (spec: string) => NamespaceResolution {
  return spec => {
    const baseResolution = base(spec)
    if (baseResolution.ok) return baseResolution
    if (spec.startsWith('mcp/') || spec === 'freecode:builtins') {
      return baseResolution
    }
    const mod = resolveRunCodeModule(spec)
    if (!mod.ok) {
      return { ok: false, error: `${baseResolution.error} ${mod.error}` }
    }
    return mod
  }
}
