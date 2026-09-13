import { execFileSync, execSync, spawn, type ChildProcess } from 'child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'fs'
import { arch, platform } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  validatePublicUrl,
  type TunnelHandle,
  type TunnelStartOptions,
} from './types.js'

const URL_PATTERN = /https:\/\/[^\s"'<>]+\.trycloudflare\.com/
const REGISTERED_RE = /Registered tunnel connection/

const GITHUB_RELEASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download'

export const CLOUDFLARED_STARTUP_TIMEOUT_MS = 60_000

export type CloudflaredDeps = {
  resolveBinary: () => Promise<string>
  spawnProcess: (binary: string, args: readonly string[]) => ChildProcess
  startupTimeoutMs: number
}

export function defaultCloudflaredDeps(): CloudflaredDeps {
  return {
    resolveBinary: ensureCloudflaredBinary,
    spawnProcess: (bin, args) =>
      spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
    startupTimeoutMs: CLOUDFLARED_STARTUP_TIMEOUT_MS,
  }
}

// ---------------------------------------------------------------------------
// Binary management
// ---------------------------------------------------------------------------

function downloadUrl(): string {
  const os = platform()
  const cpu = arch() === 'arm64' ? 'arm64' : 'amd64'
  if (os === 'darwin') return `${GITHUB_RELEASE}/cloudflared-darwin-${cpu}.tgz`
  if (os === 'linux') return `${GITHUB_RELEASE}/cloudflared-linux-${cpu}`
  throw new Error(`cloudflared auto-install is not supported on ${os}/${cpu}`)
}

function binDir(): string {
  return join(getClaudeConfigHomeDir(), 'bin')
}

function managedBinaryPath(): string {
  return join(binDir(), 'cloudflared')
}

function findBinary(): string | null {
  try {
    return execFileSync('which', ['cloudflared'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // not in PATH
  }
  const managed = managedBinaryPath()
  return existsSync(managed) ? managed : null
}

async function downloadBinary(): Promise<string> {
  const url = downloadUrl()
  const dir = binDir()
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const dest = managedBinaryPath()
  const tmp = `${dest}.tmp`

  // biome-ignore lint/suspicious/noConsole:: progress feedback during install
  console.log(`Downloading cloudflared from ${url}`)

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }

  if (url.endsWith('.tgz')) {
    const tgzPath = `${dest}.tgz`
    const out = createWriteStream(tgzPath)
    await pipeline(response.body as unknown as NodeJS.ReadableStream, out)
    execSync(`tar xzf ${tgzPath} -C ${dir} cloudflared`, { stdio: 'ignore' })
    try {
      unlinkSync(tgzPath)
    } catch {}
    if (!existsSync(dest)) {
      throw new Error('cloudflared binary not found in downloaded archive')
    }
    chmodSync(dest, 0o755)
  } else {
    const out = createWriteStream(tmp)
    await pipeline(response.body as unknown as NodeJS.ReadableStream, out)
    chmodSync(tmp, 0o755)
    renameSync(tmp, dest)
  }

  // biome-ignore lint/suspicious/noConsole:: progress feedback during install
  console.log('cloudflared installed')
  return dest
}

export async function ensureCloudflaredBinary(): Promise<string> {
  const existing = findBinary()
  if (existing) return existing
  return downloadBinary()
}

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

export type CloudflaredReadiness = {
  /**
   * Pattern for the URL the process must print (quick tunnels). Null for
   * named tunnels, whose URL is already known from configuration.
   */
  urlPattern: RegExp | null
  /** Turns the scanned URL (or nothing, for named tunnels) into the public URL. */
  publicUrl: (scannedUrl: string | null) => string
}

/**
 * Wait for cloudflared to register at least one tunnel connection AND, when a
 * pattern is given, to print its quick-tunnel URL. Registration alone is not
 * sufficient for quick tunnels: cloudflared documents the URL as "may take
 * some time to be reachable."
 */
function waitForStartup(
  child: ChildProcess,
  signal: AbortSignal,
  urlPattern: RegExp | null,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    let url: string | null = null
    let registered = false
    let stdoutCarry = ''
    let stderrCarry = ''

    function scan(text: string): void {
      if (urlPattern && !url) {
        const m = urlPattern.exec(text)
        if (m) {
          try {
            url = validatePublicUrl(m[0])
          } catch (e) {
            cleanup()
            reject(e)
            return
          }
        }
      }
      if (!registered && REGISTERED_RE.test(text)) registered = true
      if (registered && (url || !urlPattern)) {
        cleanup()
        resolve(url)
      }
    }

    function onStdout(chunk: Buffer): void {
      const combined = stdoutCarry + chunk.toString('utf-8')
      scan(combined)
      stdoutCarry = combined.slice(-4096)
    }

    function onStderr(chunk: Buffer): void {
      const combined = stderrCarry + chunk.toString('utf-8')
      scan(combined)
      stderrCarry = combined.slice(-4096)
    }

    function onAbort(): void {
      cleanup()
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('startup aborted'),
      )
    }

    function cleanup(): void {
      child.stdout?.removeListener('data', onStdout)
      child.stderr?.removeListener('data', onStderr)
      signal.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function terminate(child: ChildProcess): void {
  child.kill('SIGTERM')
  child.stdout?.destroy()
  child.stderr?.destroy()
}

/**
 * Spawn cloudflared and resolve once the tunnel is registered, with one
 * deadline covering URL extraction, registration, and reachability.
 */
export async function runCloudflared(
  deps: CloudflaredDeps,
  args: readonly string[],
  start: TunnelStartOptions,
  readiness: CloudflaredReadiness,
): Promise<TunnelHandle> {
  const binary = await deps.resolveBinary()
  const child: ChildProcess = deps.spawnProcess(binary, args)

  const startup = new AbortController()
  const timer = setTimeout(
    () =>
      startup.abort(
        new Error(
          `cloudflared did not become ready within ${deps.startupTimeoutMs / 1000}s`,
        ),
      ),
    deps.startupTimeoutMs,
  )

  const onChildError = (err: Error): void => {
    if (!startup.signal.aborted)
      startup.abort(new Error(`cloudflared failed to start: ${err.message}`))
  }
  const onChildExit = (code: number | null, sig: string | null): void => {
    if (!startup.signal.aborted) {
      const detail = sig ? `signal ${sig}` : `code ${code}`
      startup.abort(new Error(`cloudflared exited before ready (${detail})`))
    }
  }
  const onCallerAbort = (): void => {
    if (!startup.signal.aborted)
      startup.abort(new Error('cloudflared startup cancelled'))
  }

  child.once('error', onChildError)
  child.once('exit', onChildExit)
  start.signal.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const scannedUrl = await waitForStartup(
      child,
      startup.signal,
      readiness.urlPattern,
    )

    const onAbort = (): void => {
      terminate(child)
    }
    start.signal.addEventListener('abort', onAbort, { once: true })

    return {
      publicUrl: readiness.publicUrl(scannedUrl),
      async close() {
        start.signal.removeEventListener('abort', onAbort)
        terminate(child)
      },
    }
  } catch (err) {
    terminate(child)
    throw err
  } finally {
    clearTimeout(timer)
    child.removeListener('error', onChildError)
    child.removeListener('exit', onChildExit)
    start.signal.removeEventListener('abort', onCallerAbort)
  }
}

/** Pattern for the URL a quick tunnel prints on stdout/stderr. */
export const QUICK_TUNNEL_URL_PATTERN = URL_PATTERN
