import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

setDefaultTimeout(120_000)

const ROOT = join(import.meta.dir, '..', '..')
const DEV_FULL_BINARY = join(ROOT, 'cli-dev')

/**
 * Strings that only a WebUI build can contain. The WebUI is compiled into
 * every build now; this guards against a build regression that silently
 * drops the embedded client.
 *
 * Every entry must be unique to this feature. CSP directive names are not:
 * highlight.js ships a Content-Security-Policy grammar that lists
 * `frame-ancestors` as a keyword, so it appears in every build.
 */
const MARKERS = [
  'bad attach token',
  'claude web <command>',
  'freecode_webui',
  'Denied from the WebUI',
  'the session did not become attachable',
]

function binaryContains(path: string, needle: string): boolean {
  // Read once per call is wasteful but this runs a handful of times, and
  // holding a 200MB buffer across the suite is worse.
  return readFileSync(path, 'latin1').includes(needle)
}

describe('WebUI embedding', () => {
  test('the compiled binary carries the WebUI', () => {
    if (!existsSync(DEV_FULL_BINARY)) {
      throw new Error('cli-dev is missing. Run: bun run build:dev:full')
    }
    for (const marker of MARKERS) {
      expect(binaryContains(DEV_FULL_BINARY, marker)).toBe(true)
    }
  })
})
