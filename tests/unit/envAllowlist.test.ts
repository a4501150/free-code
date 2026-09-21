import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const {
  ALLOWED_ENV_VARS,
  AUTH_ENV_VARS,
  PROCESS_MECHANICS_ENV_VARS,
  DEBUG_OPS_ENV_VARS,
} = await import('../../src/utils/envAllowlist.js')

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCAN_DIRS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'scripts')]

// process.env.NAME and process.env['NAME'] (and double-quote) forms.
const ENV_READ_RE =
  /process\.env(?:\.|\[['"])(CLAUDE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+)/g

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry === 'node_modules' || entry === 'generated') continue
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(ts|tsx)$/.test(entry)) yield path
  }
}

describe('env var allowlist', () => {
  test('every CLAUDE_/ANTHROPIC env read in src and scripts is allowlisted', () => {
    const violations: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        if (file.endsWith('envAllowlist.ts')) continue // the inventory itself
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          for (const match of line.matchAll(ENV_READ_RE)) {
            if (!ALLOWED_ENV_VARS.has(match[1])) {
              violations.push(
                `${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${match[1]}`,
              )
            }
          }
        })
      }
    }
    expect(violations).toEqual([])
  })

  test('allowlist groups are internally consistent', () => {
    const all = [
      ...AUTH_ENV_VARS,
      ...PROCESS_MECHANICS_ENV_VARS,
      ...DEBUG_OPS_ENV_VARS,
    ]
    expect(new Set(all).size).toBe(all.length) // no name in two buckets
    for (const name of all) {
      expect(/^(CLAUDE|ANTHROPIC)_/.test(name)).toBe(true)
    }
  })
})
