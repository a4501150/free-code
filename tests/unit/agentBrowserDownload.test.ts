import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  AGENT_BROWSER_VERSION,
  agentBrowserPaths,
  ensureCurrentAgentBrowser,
  platformDir,
  readInstalledAgentBrowserVersion,
} from '../../scripts/agentBrowser.js'

// No mock.module here: this file imports the script directly and only swaps
// globalThis.fetch (restored per test), so nothing leaks into other files.

const EXE = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'

const realFetch = globalThis.fetch
let cwd: string
let fetchUrls: string[]

function fakeResponse(body: string | Uint8Array, status = 200): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status,
  })
}

/** Build a real tar.gz holding `content` at its root, as the release does. */
function buildArchive(content: string): Uint8Array {
  const stage = mkdtempSync(join(tmpdir(), 'ab-test-stage-'))
  try {
    writeFileSync(join(stage, EXE), content)
    const archivePath = join(stage, 'archive.tar.gz')
    const proc = Bun.spawnSync({
      cmd: ['tar', '-czf', archivePath, '-C', stage, EXE],
    })
    if (proc.exitCode !== 0) throw new Error('failed to build test archive')
    return new Uint8Array(readFileSync(archivePath))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function seedVendorDir(version: string | null, content = 'old-binary'): void {
  const { binDir, binPath, markerPath } = agentBrowserPaths(cwd)
  mkdirSync(binDir, { recursive: true })
  writeFileSync(binPath, content)
  if (version !== null) writeFileSync(markerPath, version)
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'freecode-ab-test-'))
  fetchUrls = []
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(cwd, { recursive: true, force: true })
  delete process.env.SKIP_AGENT_BROWSER_DOWNLOAD
})

describe('readInstalledAgentBrowserVersion', () => {
  test('null when nothing is vendored', () => {
    expect(readInstalledAgentBrowserVersion(cwd)).toBeNull()
  })

  test('null for an unmarked executable (older markerless layout)', () => {
    seedVendorDir(null)
    expect(readInstalledAgentBrowserVersion(cwd)).toBeNull()
  })

  test('returns the trimmed marker content', () => {
    seedVendorDir('0.0.9\n')
    expect(readInstalledAgentBrowserVersion(cwd)).toBe('0.0.9')
  })
})

describe('ensureCurrentAgentBrowser', () => {
  test('downloads when the executable is missing', async () => {
    const archive = buildArchive('new-binary')
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      if (url.endsWith('.sha256')) return fakeResponse(`${sha256(archive)}\n`)
      return fakeResponse(archive)
    }) as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    const { binPath, markerPath } = agentBrowserPaths(cwd)
    expect(readFileSync(binPath, 'utf8')).toBe('new-binary')
    expect(readFileSync(markerPath, 'utf8').trim()).toBe(AGENT_BROWSER_VERSION)
    expect(readInstalledAgentBrowserVersion(cwd)).toBe(AGENT_BROWSER_VERSION)
    expect(fetchUrls.some(url => url.includes('/agent-browser'))).toBe(true)
    expect(fetchUrls.some(url => url.includes(AGENT_BROWSER_VERSION))).toBe(
      true,
    )
  })

  test('skips the download when executable and marker match the version', async () => {
    seedVendorDir(AGENT_BROWSER_VERSION, 'current-binary')
    globalThis.fetch = (async () => {
      throw new Error('should not fetch')
    }) as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    expect(readFileSync(agentBrowserPaths(cwd).binPath, 'utf8')).toBe(
      'current-binary',
    )
    expect(fetchUrls).toEqual([])
  })

  test('re-downloads when the marker records an older version', async () => {
    seedVendorDir('0.1.0', 'old-binary')
    const archive = buildArchive('new-binary')
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      if (url.endsWith('.sha256')) return fakeResponse(sha256(archive))
      return fakeResponse(archive)
    }) as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    const { binPath, markerPath } = agentBrowserPaths(cwd)
    expect(readFileSync(binPath, 'utf8')).toBe('new-binary')
    expect(readFileSync(markerPath, 'utf8').trim()).toBe(AGENT_BROWSER_VERSION)
  })

  test('re-downloads on a malformed marker', async () => {
    seedVendorDir('not-a-version')
    const archive = buildArchive('new-binary')
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      fetchUrls.push(url)
      if (url.endsWith('.sha256')) return fakeResponse(sha256(archive))
      return fakeResponse(archive)
    }) as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    expect(fetchUrls.length).toBeGreaterThan(0)
    expect(readInstalledAgentBrowserVersion(cwd)).toBe(AGENT_BROWSER_VERSION)
  })

  test('a failed update keeps the previous executable and marker', async () => {
    seedVendorDir('0.1.0', 'old-binary')
    globalThis.fetch = (async () =>
      fakeResponse('boom', 500)) as unknown as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    const { binPath, markerPath } = agentBrowserPaths(cwd)
    expect(readFileSync(binPath, 'utf8')).toBe('old-binary')
    expect(readFileSync(markerPath, 'utf8').trim()).toBe('0.1.0')
    expect(existsSync(`${binPath}.tmp`)).toBe(false)
  })

  test('a checksum mismatch keeps the previous executable and marker', async () => {
    seedVendorDir('0.1.0', 'old-binary')
    const archive = buildArchive('new-binary')
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('.sha256')) return fakeResponse(`${'0'.repeat(64)}  x`)
      return fakeResponse(archive)
    }) as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    const { binPath, markerPath } = agentBrowserPaths(cwd)
    expect(readFileSync(binPath, 'utf8')).toBe('old-binary')
    expect(readFileSync(markerPath, 'utf8').trim()).toBe('0.1.0')
  })

  test('an unpublished archive keeps the previous files', async () => {
    seedVendorDir('0.1.0', 'old-binary')
    globalThis.fetch = (async () =>
      fakeResponse('not found', 404)) as unknown as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    const { binPath, markerPath } = agentBrowserPaths(cwd)
    expect(readFileSync(binPath, 'utf8')).toBe('old-binary')
    expect(readFileSync(markerPath, 'utf8').trim()).toBe('0.1.0')
  })

  test('SKIP_AGENT_BROWSER_DOWNLOAD skips the download even when stale', async () => {
    process.env.SKIP_AGENT_BROWSER_DOWNLOAD = '1'
    seedVendorDir('0.1.0', 'old-binary')
    globalThis.fetch = (async () => {
      throw new Error('should not fetch')
    }) as typeof fetch

    await ensureCurrentAgentBrowser({ cwd })

    const { binPath, markerPath } = agentBrowserPaths(cwd)
    expect(readFileSync(binPath, 'utf8')).toBe('old-binary')
    expect(readFileSync(markerPath, 'utf8').trim()).toBe('0.1.0')
  })

  test('the default target is this platform vendored dir', () => {
    expect(platformDir()).toBe(`${process.arch}-${process.platform}`)
    expect(agentBrowserPaths(cwd).binPath).toBe(
      join(
        cwd,
        'vendor/agent-browser',
        `${process.arch}-${process.platform}`,
        EXE,
      ),
    )
  })
})
