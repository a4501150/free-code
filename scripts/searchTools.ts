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

const SEARCH_TOOLS_VERSION = 'v1'
const SEARCH_TOOLS_VENDOR_DIR = 'vendor/search-tools'
const DEFAULT_SEARCH_TOOLS_BASE_URL = `https://github.com/a4501150/free-code/releases/download/search-tools-${SEARCH_TOOLS_VERSION}`

function platformDir(): string {
  return `${process.arch}-${process.platform}`
}

function binaryName(name: 'bfs' | 'ugrep'): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function currentToolPaths(): { bfsPath: string; ugrepPath: string } {
  const binDir = resolve(process.cwd(), SEARCH_TOOLS_VENDOR_DIR, platformDir())
  return {
    bfsPath: resolve(binDir, binaryName('bfs')),
    ugrepPath: resolve(binDir, binaryName('ugrep')),
  }
}

function hasCurrentSearchTools(): boolean {
  const { bfsPath, ugrepPath } = currentToolPaths()
  return existsSync(bfsPath) && existsSync(ugrepPath)
}

function assetBaseUrl(): string {
  return (
    process.env.SEARCH_TOOLS_BASE_URL?.replace(/\/$/, '') ??
    DEFAULT_SEARCH_TOOLS_BASE_URL
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
  mkdirSync(resolve(process.cwd(), SEARCH_TOOLS_VENDOR_DIR), {
    recursive: true,
  })
  const proc = Bun.spawnSync({
    cmd: ['tar', '-xzf', archivePath, '-C', SEARCH_TOOLS_VENDOR_DIR],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (proc.exitCode !== 0) throw new Error(`Failed to extract ${archivePath}`)
}

function markBinariesExecutable(): void {
  const { bfsPath, ugrepPath } = currentToolPaths()
  if (existsSync(bfsPath)) chmodSync(bfsPath, 0o755)
  if (existsSync(ugrepPath)) chmodSync(ugrepPath, 0o755)
}

async function downloadCurrentSearchTools(): Promise<boolean> {
  const platform = platformDir()
  const archiveName = `search-tools-${platform}.tar.gz`
  const baseUrl = assetBaseUrl()
  const archiveUrl = `${baseUrl}/${archiveName}`
  const checksumUrl = `${baseUrl}/${archiveName}.sha256`
  const tmpRoot = mkdtempSync(join(tmpdir(), 'freecode-search-tools-'))

  try {
    const archivePath = join(tmpRoot, archiveName)
    if (!(await downloadFile(archiveUrl, archivePath))) return false
    await verifyChecksum(archivePath, checksumUrl)
    extractArchive(archivePath)
    markBinariesExecutable()

    if (!hasCurrentSearchTools()) {
      throw new Error(
        `${archiveName} did not contain ${platform}/${binaryName('bfs')} and ${platform}/${binaryName('ugrep')}`,
      )
    }

    return true
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

export async function ensureCurrentSearchTools(): Promise<void> {
  if (hasCurrentSearchTools()) return
  if (process.env.SKIP_SEARCH_TOOLS_DOWNLOAD === '1') return

  console.log(`Search tools missing for ${platformDir()}, downloading...`)
  try {
    if (await downloadCurrentSearchTools()) {
      console.log(`Downloaded ${SEARCH_TOOLS_VENDOR_DIR}/${platformDir()}`)
      return
    }
  } catch (error) {
    console.warn(`Failed to download search tools: ${error}`)
    return
  }

  console.warn(
    `Search tools are not available for ${platformDir()}; Bash find/grep will use system tools unless ${SEARCH_TOOLS_VENDOR_DIR} is populated manually.`,
  )
}
