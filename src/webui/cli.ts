import { readAuthFile, writeAuthFile } from './gateway/auth.js'
import {
  sendDaemonControl,
  type DaemonControlResponse,
} from './daemonControl.js'
import type { WebStartOptions, WebStatus } from './gateway/service.js'
import { readWebState } from './gateway/webState.js'

function print(line: string): void {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(line)
}

function usage(): void {
  print('Usage: claude web <command> [options]')
  print('')
  print('Commands:')
  print('  start   Start the web server (and tunnel) inside the daemon')
  print('  stop    Stop the web server and tunnel')
  print('  restart Restart the daemon and the web server, reusing the URL')
  print('  status  Show whether the web server is running')
  print('  url     Print the public URL, with a QR code')
  print('')
  print('Start options:')
  print('  --port <n>              Loopback port. Default: an ephemeral port')
  print('  --tunnel <kind>         localtunnel | command | none')
  print(
    '  --tunnel-command <cmd>  Command that prints an https URL. {port} is substituted',
  )
  print('  --tunnel-host <url>     Self-hosted localtunnel server')
  print('  --subdomain <name>      Requested localtunnel subdomain')
  print('  --password-stdin        Read the password from stdin')
  print('  --reset-password        Replace the stored password')
}

function parseStartOptions(args: string[]): WebStartOptions {
  const options: WebStartOptions = { tunnel: 'localtunnel' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    switch (arg) {
      case '--port':
        options.port = Number(next)
        i++
        break
      case '--tunnel':
        if (next !== 'localtunnel' && next !== 'command' && next !== 'none') {
          throw new Error(`unknown tunnel kind: ${next}`)
        }
        options.tunnel = next
        i++
        break
      case '--tunnel-command':
        options.tunnelCommand = next
        i++
        break
      case '--tunnel-host':
        options.tunnelHost = next
        i++
        break
      case '--subdomain':
        options.subdomain = next
        i++
        break
      default:
        break
    }
  }
  return options
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

/**
 * Prompts without echo. A password typed at a TTY must not land in the
 * scrollback of a shared terminal.
 */
async function promptPassword(label: string): Promise<string> {
  process.stdout.write(label)
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)
  stdin.resume()

  return new Promise(resolve => {
    let value = ''
    const onData = (buffer: Buffer): void => {
      const text = buffer.toString('utf-8')
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode?.(wasRaw ?? false)
          stdin.pause()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          stdin.setRawMode?.(wasRaw ?? false)
          process.exit(130)
        }
        if (char === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function ensurePassword(args: string[]): Promise<boolean> {
  const reset = args.includes('--reset-password')
  if (readAuthFile() && !reset) return true

  if (args.includes('--password-stdin')) {
    const password = await readPasswordFromStdin()
    if (password.length < 8) {
      print('Password must be at least 8 characters.')
      return false
    }
    await writeAuthFile(password)
    return true
  }

  if (!process.stdin.isTTY) {
    print('No password is set. Run with --password-stdin, or from a terminal.')
    return false
  }

  print('')
  print('Set a password for the web interface.')
  print('')
  print('Read this first. Anyone with this password can approve a command')
  print('that runs on this machine. Treat it like an SSH key, not a login.')
  print('')

  const first = await promptPassword('Password: ')
  if (first.length < 8) {
    print('Password must be at least 8 characters.')
    return false
  }
  const second = await promptPassword('Confirm:  ')
  if (first !== second) {
    print('Passwords did not match.')
    return false
  }

  await writeAuthFile(first)
  print('Password saved.')
  return true
}

function reportStatus(status: WebStatus): void {
  if (!status.running) {
    print('Web server is not running')
    return
  }
  print(`Web server is running at ${status.url}`)
  if (status.publicUrl) {
    print(`Public URL:  ${status.publicUrl}`)
  } else if (status.tunnelError) {
    print(`Tunnel failed: ${status.tunnelError}`)
    print('The server is still reachable on loopback.')
  } else if (status.tunnel) {
    print(`Tunnel: ${status.tunnel}`)
  }
}

async function ensureDaemon(): Promise<boolean> {
  const probe = await sendDaemonControl({ kind: 'web.status' }, 2000)
  if (probe) return true

  const { daemonMain } = await import('../daemon/main.js')
  await daemonMain(['start'])

  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(100)
    if (await sendDaemonControl({ kind: 'web.status' }, 2000)) return true
  }
  print('The daemon did not come up.')
  return false
}

/**
 * Stops the supervisor and waits for its control socket to go away.
 *
 * Restarting the gateway alone cannot pick up a new build: the supervisor is a
 * long-lived process still running the old binary, and it spawns sessions from
 * its own `process.execPath`.
 */
async function stopDaemonAndWait(): Promise<void> {
  const { daemonMain } = await import('../daemon/main.js')
  await daemonMain(['stop'])
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await sendDaemonControl({ kind: 'web.status' }, 1000))) return
    await Bun.sleep(100)
  }
}

function unwrap(response: DaemonControlResponse | null): WebStatus | null {
  if (!response) {
    print('The daemon is not running. Start it with: claude web start')
    return null
  }
  if (!response.ok) {
    print(`Error: ${response.error}`)
    return null
  }
  return response.status
}

export async function webMain(args: string[]): Promise<void> {
  const command = args[0]
  const rest = args.slice(1)

  async function launch(options: WebStartOptions): Promise<boolean> {
    if (!(await ensureDaemon())) return false
    const status = unwrap(
      await sendDaemonControl({ kind: 'web.start', options }),
    )
    if (!status) return false
    reportStatus(status)
    if (status.publicUrl) {
      print('')
      await printQr(status.publicUrl)
    }
    return true
  }

  switch (command) {
    case 'start': {
      if (!(await ensurePassword(rest))) {
        process.exitCode = 1
        return
      }
      let options: WebStartOptions
      try {
        options = parseStartOptions(rest)
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
        return
      }
      if (!(await launch(options))) process.exitCode = 1
      return
    }

    case 'restart': {
      const previous = readWebState()
      if (!previous) {
        print('Nothing to restart. Start it first with: claude web start')
        process.exitCode = 1
        return
      }

      // Ask the tunnel for the hostname it gave last time, so a URL already
      // open on a phone keeps working. The provider may refuse it, in which
      // case the new URL is reported as usual.
      const options: WebStartOptions = {
        ...previous.options,
        ...(previous.subdomain ? { subdomain: previous.subdomain } : {}),
      }

      await sendDaemonControl({ kind: 'web.stop' })
      await stopDaemonAndWait()
      print('Daemon stopped. Starting it again on the current build.')

      if (!(await launch(options))) process.exitCode = 1
      return
    }

    case 'stop': {
      const status = unwrap(await sendDaemonControl({ kind: 'web.stop' }))
      if (!status) {
        process.exitCode = 1
        return
      }
      print('Web server stopped')
      print('The daemon is still running. Use `claude web restart` to')
      print('reload it after a rebuild, or `claude daemon stop` to end it.')
      return
    }

    case 'status': {
      const status = unwrap(await sendDaemonControl({ kind: 'web.status' }))
      if (!status) {
        process.exitCode = 1
        return
      }
      reportStatus(status)
      return
    }

    case 'url': {
      const status = unwrap(await sendDaemonControl({ kind: 'web.status' }))
      if (!status) {
        process.exitCode = 1
        return
      }
      const url = status.publicUrl ?? status.url
      if (!url) {
        print('Web server is not running')
        process.exitCode = 1
        return
      }
      print(url)
      await printQr(url)
      return
    }

    default:
      usage()
  }
}

async function printQr(url: string): Promise<void> {
  try {
    const qrcode = await import('qrcode')
    const rendered = await qrcode.default.toString(url, {
      type: 'terminal',
      small: true,
    })
    print(rendered)
  } catch {
    // A missing QR renderer must not fail the command that already worked.
  }
}
