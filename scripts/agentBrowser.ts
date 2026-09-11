import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'

// The bundled agent-browser MCP server (web_search/web_fetch/browser_*).
// Assets come from the agent-browser repo's v<version> release tag (the
// browser binary assets there use a separate chromium-<ver>-<rev> tag); see
// that repo's scripts/package-server-binary.mjs for how they are built.
const AGENT_BROWSER_VERSION = '0.1.0'
const AGENT_BROWSER_VENDOR_DIR = 'vendor/agent-browser'
const DEFAULT_AGENT_BROWSER_BASE_URL = `https://github.com/a4501150/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}`

/** Vendor layout matches ripgrep/search-tools: <arch>-<platform>/<exe>. */
function platformDir(): string {
  return `${process.arch}-${process.platform}`
}

/** Release assets are named with the agent-browser platform key. */
function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function binaryName(): string {
  return process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'
}

function currentBinaryPath(): string {
  return resolve(
    process.cwd(),
    AGENT_BROWSER_VENDOR_DIR,
    platformDir(),
    binaryName(),
  )
}

function hasCurrentAgentBrowser(): boolean {
  return existsSync(currentBinaryPath())
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

function extractArchive(archivePath: string): void {
  const binDir = resolve(process.cwd(), AGENT_BROWSER_VENDOR_DIR, platformDir())
  mkdirSync(binDir, { recursive: true })
  // The archive holds the executable at its root (single-file bun binary).
  const proc = Bun.spawnSync({
    cmd: ['tar', '-xzf', archivePath, '-C', binDir],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (proc.exitCode !== 0) throw new Error(`Failed to extract ${archivePath}`)
}

async function downloadCurrentAgentBrowser(): Promise<boolean> {
  const archiveName = `agent-browser-server-${AGENT_BROWSER_VERSION}-${platformKey()}.tar.gz`
  const baseUrl = assetBaseUrl()
  const archiveUrl = `${baseUrl}/${archiveName}`
  const checksumUrl = `${baseUrl}/${archiveName}.sha256`
  const tmpRoot = mkdtempSync(join(tmpdir(), 'freecode-agent-browser-'))

  try {
    const archivePath = join(tmpRoot, archiveName)
    if (!(await downloadFile(archiveUrl, archivePath))) return false
    await verifyChecksum(archivePath, checksumUrl)
    extractArchive(archivePath)

    const binPath = currentBinaryPath()
    if (!existsSync(binPath)) {
      throw new Error(
        `${archiveName} did not contain ${binaryName()} at its root`,
      )
    }
    chmodSync(binPath, 0o755)

    return true
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

export async function ensureCurrentAgentBrowser(): Promise<void> {
  if (hasCurrentAgentBrowser()) return
  if (process.env.SKIP_AGENT_BROWSER_DOWNLOAD === '1') return

  console.log(
    `agent-browser server missing for ${platformDir()}, downloading...`,
  )
  try {
    if (await downloadCurrentAgentBrowser()) {
      console.log(
        `Downloaded ${AGENT_BROWSER_VENDOR_DIR}/${platformDir()}/${binaryName()}`,
      )
      return
    }
  } catch (error) {
    console.warn(`Failed to download agent-browser server: ${error}`)
    return
  }

  console.warn(
    `agent-browser server is not published for ${platformDir()}; the built-in web tools MCP will stay unregistered until ${AGENT_BROWSER_VENDOR_DIR} is populated manually.`,
  )
}
