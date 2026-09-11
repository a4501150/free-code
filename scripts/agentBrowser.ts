import { createHash } from 'crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'

// The bundled agent-browser MCP server (web_search/web_fetch/browser_*).
// Assets come from the agent-browser repo's v<version> release tag (the
// browser binary assets there use a separate chromium-<ver>-<rev> tag); see
// that repo's scripts/package-server-binary.mjs for how they are built.
export const AGENT_BROWSER_VERSION = '0.1.1'
const AGENT_BROWSER_VENDOR_DIR = 'vendor/agent-browser'
const DEFAULT_AGENT_BROWSER_BASE_URL = `https://github.com/a4501150/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}`

/** Vendor layout matches ripgrep/search-tools: <arch>-<platform>/<exe>. */
export function platformDir(): string {
  return `${process.arch}-${process.platform}`
}

/** Release assets are named with the agent-browser platform key. */
function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function binaryName(): string {
  return process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'
}

export function agentBrowserPaths(cwd: string) {
  const binDir = resolve(cwd, AGENT_BROWSER_VENDOR_DIR, platformDir())
  return {
    binDir,
    binPath: join(binDir, binaryName()),
    markerPath: join(binDir, `${binaryName()}.version`),
  }
}

/**
 * Version recorded for the vendored executable, or null when the executable
 * or a readable, non-empty marker is absent (unmarked/older layout, partial
 * update, or tampered marker).
 */
export function readInstalledAgentBrowserVersion(cwd: string): string | null {
  const { binPath, markerPath } = agentBrowserPaths(cwd)
  if (!existsSync(binPath)) return null
  try {
    const version = readFileSync(markerPath, 'utf8').trim()
    return version.length > 0 ? version : null
  } catch {
    return null
  }
}

function assetBaseUrl(): string {
  return (
    process.env.AGENT_BROWSER_BASE_URL?.replace(/\/$/, '') ??
    DEFAULT_AGENT_BROWSER_BASE_URL
  )
}

async function downloadFile(
  url: string,
  destination: string,
): Promise<boolean> {
  const response = await fetch(url)
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }

  mkdirSync(dirname(destination), { recursive: true })
  await Bun.write(destination, response)
  return true
}

function sha256(path: string): string {
  const hasher = createHash('sha256')
  hasher.update(readFileSync(path))
  return hasher.digest('hex')
}

async function verifyChecksum(
  archivePath: string,
  checksumUrl: string,
): Promise<void> {
  const response = await fetch(checksumUrl)
  if (response.status === 404) {
    throw new Error(`Missing checksum file ${checksumUrl}`)
  }
  if (!response.ok) {
    throw new Error(
      `Failed to download ${checksumUrl}: HTTP ${response.status}`,
    )
  }

  const checksumText = await response.text()
  const expected = checksumText.match(/[a-fA-F0-9]{64}/)?.[0]?.toLowerCase()
  if (!expected) throw new Error(`Invalid checksum file from ${checksumUrl}`)

  const actual = sha256(archivePath)
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${archivePath}: expected ${expected}, got ${actual}`,
    )
  }
}

/**
 * Download, verify and extract entirely inside a temp dir, validate the
 * expected executable, then swap it into vendor and write the marker. The
 * vendor executable is replaced via a same-directory rename and the marker
 * is written only after that, so any download/checksum/extract failure
 * leaves the previous executable and marker untouched.
 */
async function downloadCurrentAgentBrowser(cwd: string): Promise<boolean> {
  const archiveName = `agent-browser_${AGENT_BROWSER_VERSION}_${platformKey()}.tar.gz`
  const baseUrl = assetBaseUrl()
  const archiveUrl = `${baseUrl}/${archiveName}`
  const checksumUrl = `${baseUrl}/${archiveName}.sha256`
  const tmpRoot = mkdtempSync(join(tmpdir(), 'freecode-agent-browser-'))

  try {
    const archivePath = join(tmpRoot, archiveName)
    if (!(await downloadFile(archiveUrl, archivePath))) return false
    await verifyChecksum(archivePath, checksumUrl)

    const extractDir = join(tmpRoot, 'extract')
    mkdirSync(extractDir, { recursive: true })
    // The archive holds the executable at its root (single-file bun binary).
    const proc = Bun.spawnSync({
      cmd: ['tar', '-xzf', archivePath, '-C', extractDir],
      cwd,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (proc.exitCode !== 0) throw new Error(`Failed to extract ${archivePath}`)

    const extracted = join(extractDir, binaryName())
    if (!existsSync(extracted)) {
      throw new Error(
        `${archiveName} did not contain ${binaryName()} at its root`,
      )
    }
    const { binDir, binPath, markerPath } = agentBrowserPaths(cwd)
    mkdirSync(binDir, { recursive: true })
    // Stage on the target filesystem so each rename is atomic. A unique
    // directory also keeps concurrent builds from sharing partial files.
    const stagingDir = mkdtempSync(join(binDir, '.agent-browser-update-'))
    try {
      const stagedBin = join(stagingDir, binaryName())
      copyFileSync(extracted, stagedBin)
      chmodSync(stagedBin, 0o755)
      renameSync(stagedBin, binPath)

      // Marker last: its content is the completeness signal for later runs.
      const stagedMarker = join(stagingDir, `${binaryName()}.version`)
      writeFileSync(stagedMarker, `${AGENT_BROWSER_VERSION}\n`)
      renameSync(stagedMarker, markerPath)
    } finally {
      rmSync(stagingDir, { recursive: true, force: true })
    }

    return true
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

export async function ensureCurrentAgentBrowser(options?: {
  cwd?: string
}): Promise<void> {
  const cwd = options?.cwd ?? process.cwd()
  const installed = readInstalledAgentBrowserVersion(cwd)
  if (installed === AGENT_BROWSER_VERSION) return
  if (process.env.SKIP_AGENT_BROWSER_DOWNLOAD === '1') {
    if (installed) {
      console.warn(
        `Vendored agent-browser is v${installed}, expected v${AGENT_BROWSER_VERSION}; keeping the existing binary (SKIP_AGENT_BROWSER_DOWNLOAD).`,
      )
    }
    return
  }

  console.log(
    `Vendored agent-browser is ${installed ? `v${installed}` : 'missing or unmarked'}, expected v${AGENT_BROWSER_VERSION} for ${platformDir()}; downloading...`,
  )
  try {
    if (await downloadCurrentAgentBrowser(cwd)) {
      console.log(
        `Downloaded ${AGENT_BROWSER_VENDOR_DIR}/${platformDir()}/${binaryName()} v${AGENT_BROWSER_VERSION}`,
      )
      return
    }
  } catch (error) {
    console.warn(`Failed to update agent-browser server: ${error}`)
    return
  }

  console.warn(
    `agent-browser server v${AGENT_BROWSER_VERSION} is not published for ${platformDir()}; the built-in web tools MCP will stay unregistered until ${AGENT_BROWSER_VENDOR_DIR} is populated manually.`,
  )
}
