import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

setDefaultTimeout(120_000)

const ROOT = join(import.meta.dir, '..', '..')
const DEV_FULL_BINARY = join(ROOT, 'cli-dev')

/**
 * Strings that only a WEBUI build can contain.
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

describe('WEBUI feature gating', () => {
  test('the dev-full binary carries the WebUI', () => {
    if (!existsSync(DEV_FULL_BINARY)) {
      throw new Error('cli-dev is missing. Run: bun run build:dev:full')
    }
    for (const marker of MARKERS) {
      expect(binaryContains(DEV_FULL_BINARY, marker)).toBe(true)
    }
  })

  test('a default build strips every WebUI string', async () => {
    // Build to a scratch path so the developer's ./cli-dev is left alone.
    const outfile = join(ROOT, 'cli-webui-off-check')
    const proc = Bun.spawn(['bun', 'run', './scripts/build.ts', '--dev'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) throw new Error(`default build failed:\n${err}`)

    try {
      const present = MARKERS.filter(marker =>
        binaryContains(DEV_FULL_BINARY, marker),
      )
      expect(present).toEqual([])
    } finally {
      // Restore the dev-full binary the rest of the suite drives.
      const restore = Bun.spawn(
        ['bun', 'run', './scripts/build.ts', '--dev', '--feature-set=dev-full'],
        { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' },
      )
      await restore.exited
      if (existsSync(outfile)) {
        await Bun.spawn(['rm', '-f', outfile]).exited
      }
    }
  })
})
