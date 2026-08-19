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

const GITHUB_RELEASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download'

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

/**
 * Cloudflare quick tunnel. Zero account, zero config, ~100 ms added latency.
 *
 * Downloads `cloudflared` to `~/.freecode/bin/` on first use if not in PATH.
 * Each invocation gets a random hostname.
 */
export function createCloudflareTunnelProvider(): TunnelProvider {
  return {
    name: 'cloudflared',
    async start({ port, signal }: TunnelStartOptions): Promise<TunnelHandle> {
      const binary = await ensureBinary()

      const child: ChildProcess = spawn(
        binary,
        ['--config', '/dev/null', 'tunnel', '--url', `http://127.0.0.1:${port}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      const publicUrl = await new Promise<string>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          reject(new Error('cloudflared printed no tunnel URL in 60 s'))
        }, 60_000)

        const scan = (chunk: Buffer): void => {
          if (settled) return
          const match = URL_PATTERN.exec(chunk.toString('utf-8'))
          if (!match) return
          settled = true
          clearTimeout(timer)
          try {
            resolve(validatePublicUrl(match[0]))
          } catch (err) {
            reject(err)
          }
        }

        child.stdout?.on('data', scan)
        child.stderr?.on('data', scan)

        child.once('error', err => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`cloudflared failed to start: ${err.message}`))
        })
        child.once('exit', code => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`cloudflared exited with code ${code}`))
        })
      })

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
    },
  }
}
