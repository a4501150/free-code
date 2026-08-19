import {
  spawn,
  execFileSync,
  execSync,
  type ChildProcess,
} from 'child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
} from 'fs'
import { arch, platform } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  validatePublicUrl,
  type TunnelHandle,
  type TunnelProvider,
  type TunnelStartOptions,
} from './types.js'

const URL_PATTERN = /https:\/\/[^\s"'<>]+\.trycloudflare\.com/
const REGISTERED_RE = /Registered tunnel connection/

const GITHUB_RELEASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download'

const STARTUP_TIMEOUT_MS = 60_000

export type CloudflareDeps = {
  resolveBinary: () => Promise<string>
  spawnProcess: (binary: string, args: readonly string[]) => ChildProcess
  startupTimeoutMs: number
}

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
      const { unlinkSync } = await import('fs')
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

async function ensureBinary(): Promise<string> {
  const existing = findBinary()
  if (existing) return existing
  return downloadBinary()
}

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

/**
 * Wait for cloudflared to print its quick-tunnel URL AND register at least one
 * tunnel connection. The URL alone is not sufficient: cloudflared documents it
 * as "may take some time to be reachable."
 */
function waitForRegistration(
  child: ChildProcess,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    let url: string | null = null
    let registered = false
    let stdoutCarry = ''
    let stderrCarry = ''

    function scan(text: string): void {
      if (!url) {
        const m = URL_PATTERN.exec(text)
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
      if (url && registered) {
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

/**
 * Cloudflare quick tunnel. Zero account, zero config, ~100 ms added latency.
 *
 * Downloads `cloudflared` to `~/.freecode/bin/` on first use if not in PATH.
 * Each invocation gets a random hostname.
 *
 * `start()` resolves only after the tunnel connection is registered, so
 * consumers can trust the URL.
 */
export function createCloudflareTunnelProvider(
  overrides: Partial<CloudflareDeps> = {},
): TunnelProvider {
  const deps: CloudflareDeps = {
    resolveBinary: ensureBinary,
    spawnProcess: (bin, args) =>
      spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    ...overrides,
  }

  return {
    name: 'cloudflared',
    async start({ port, signal }: TunnelStartOptions): Promise<TunnelHandle> {
      const binary = await deps.resolveBinary()

      const child: ChildProcess = deps.spawnProcess(binary, [
        '--config',
        '/dev/null',
        'tunnel',
        '--url',
        `http://127.0.0.1:${port}`,
      ])

      // One deadline for URL extraction, registration, and reachability.
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
          startup.abort(
            new Error(`cloudflared failed to start: ${err.message}`),
          )
      }
      const onChildExit = (
        code: number | null,
        sig: string | null,
      ): void => {
        if (!startup.signal.aborted) {
          const detail = sig ? `signal ${sig}` : `code ${code}`
          startup.abort(
            new Error(`cloudflared exited before ready (${detail})`),
          )
        }
      }
      const onCallerAbort = (): void => {
        if (!startup.signal.aborted)
          startup.abort(new Error('cloudflared startup cancelled'))
      }

      child.once('error', onChildError)
      child.once('exit', onChildExit)
      signal.addEventListener('abort', onCallerAbort, { once: true })

      try {
        const publicUrl = await waitForRegistration(child, startup.signal)

        const onAbort = (): void => {
          child.kill('SIGTERM')
        }
        signal.addEventListener('abort', onAbort, { once: true })

        return {
          publicUrl,
          async close() {
            signal.removeEventListener('abort', onAbort)
            child.kill('SIGTERM')
          },
        }
      } catch (err) {
        child.kill('SIGTERM')
        throw err
      } finally {
        clearTimeout(timer)
        child.removeListener('error', onChildError)
        child.removeListener('exit', onChildExit)
        signal.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}
