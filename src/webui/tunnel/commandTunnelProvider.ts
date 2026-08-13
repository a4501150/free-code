import { spawn, type ChildProcess } from 'child_process'
import {
  validatePublicUrl,
  type TunnelHandle,
  type TunnelProvider,
  type TunnelStartOptions,
} from './types.js'

const URL_PATTERN = /https:\/\/[^\s"'<>]+/

/**
 * Runs an arbitrary command and scrapes the first https URL it prints.
 *
 * This is how a Cloudflare quick tunnel, ngrok, or anything else is supported
 * without another dependency, and it is what the e2e suite uses with a fake
 * emitter so tests never touch a real tunnel service.
 *
 * `{port}` in the command is replaced with the loopback port.
 */
export function createCommandTunnelProvider(command: string): TunnelProvider {
  return {
    name: 'command',
    async start({ port, signal }: TunnelStartOptions): Promise<TunnelHandle> {
      const resolved = command.replaceAll('{port}', String(port))
      const child: ChildProcess = spawn('/bin/sh', ['-c', resolved], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const publicUrl = await new Promise<string>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          reject(new Error('tunnel command printed no https URL in 60s'))
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
          reject(err)
        })
        child.once('exit', code => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`tunnel command exited with code ${code}`))
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
