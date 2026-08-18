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
  print('`claude daemon` is the same command: the supervisor exists to host')
  print('the web server, so both names drive one lifecycle.')
  print('')
  print('Commands:')
  print('  start   Start the daemon and the web server (and tunnel)')
  print('  stop    Stop the web server, the tunnel and the daemon')
  print('  restart Restart both, reusing the tunnel URL. Use after a rebuild')
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
  print('')
  print('Permission options, inherited by every session the gateway starts:')
  print('  --permission-mode <m>   default | acceptEdits | plan')
  print('  --allowed-tools <t...>  Tools that never prompt')
  print('  --disallowed-tools <t...>  Tools that are always refused')
  print('  --settings <path>       Settings file, or settings as JSON')
  print('  --setting-sources <s>   Comma-separated setting sources')
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
      case '--permission-mode':
        // `bypassPermissions` is refused here for the same reason
        // `WebPermissionModeSchema` omits it: this gateway is reachable from
        // the internet behind one password.
        if (next !== 'default' && next !== 'acceptEdits' && next !== 'plan') {
          throw new Error(`unsupported permission mode: ${next}`)
        }
        options.permissionMode = next
        i++
        break
      case '--allowed-tools':
      case '--disallowed-tools': {
        const tools: string[] = []
        while (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
          tools.push(args[++i]!)
        }
        if (arg === '--allowed-tools') options.allowedTools = tools
        else options.disallowedTools = tools
        break
      }
      case '--settings':
        options.settings = next
        i++
        break
      case '--setting-sources':
        options.settingSources = next
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
      // One lifecycle: the supervisor exists to host the server, so leaving it
      // running after a stop only produces a process that serves nothing and
      // silently ignores the next rebuild.
      const reached = await sendDaemonControl({ kind: 'web.stop' })
      if (!reached) {
        print('Not running')
        return
      }
      if (!reached.ok) {
        print(`Error: ${reached.error}`)
        process.exitCode = 1
        return
      }
      await stopDaemonAndWait()
      print('Web server and daemon stopped')
      return
    }

    case 'list': {
      const status = unwrap(await sendDaemonControl({ kind: 'web.status' }))
      if (!status) {
        process.exitCode = 1
        return
      }
      reportStatus(status)
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

// Two quiet-zone modules per side. The spec calls for four, but two is
// enough for every modern phone scanner and keeps the code compact.
const QUIET_ZONE = 2

const BG_WHITE = '\u001b[47m'
const BG_BLACK = '\u001b[40m'
const FG_WHITE = '\u001b[37m'
const FG_BLACK = '\u001b[30m'
const RESET = '\u001b[0m'

async function printQr(url: string): Promise<void> {
  try {
    const qrcode = await import('qrcode')
    const { size, data } = qrcode.default.create(url).modules
    const width = size + QUIET_ZONE * 2
    const isDark = (x: number, y: number): boolean => {
      const col = x - QUIET_ZONE
      const row = y - QUIET_ZONE
      if (col < 0 || row < 0 || col >= size || row >= size) return false
      return data[row * size + col] !== 0
    }
    // A terminal cell is about twice as tall as it is wide, so a module needs
    // two columns to come out square.
    const columns = process.stdout.columns ?? 80
    print(
      columns >= width * 2
        ? renderQrWide(width, isDark)
        : renderQrCompact(width, isDark),
    )
  } catch {
    // A missing QR renderer must not fail the command that already worked.
  }
}

// Two columns per module, painted as background color. The background fills the
// whole cell, so extra line spacing cannot open gaps between the module rows.
function renderQrWide(
  width: number,
  isDark: (x: number, y: number) => boolean,
): string {
  const rows: string[] = []
  for (let y = 0; y < width; y++) {
    let row = ''
    let painted: boolean | null = null
    for (let x = 0; x < width; x++) {
      const dark = isDark(x, y)
      if (dark !== painted) {
        row += dark ? BG_BLACK : BG_WHITE
        painted = dark
      }
      row += '  '
    }
    rows.push(row + RESET)
  }
  return rows.join('\n')
}

// Half the width, for a terminal that cannot fit the wide form. One column per
// module, two module rows per line. A terminal that adds line spacing draws
// visible seams here, so use this form only when the wide one would wrap.
function renderQrCompact(
  width: number,
  isDark: (x: number, y: number) => boolean,
): string {
  const rows: string[] = []
  for (let y = 0; y < width; y += 2) {
    let row = ''
    for (let x = 0; x < width; x++) {
      const top = isDark(x, y)
      const bottom = y + 1 < width && isDark(x, y + 1)
      row += (top ? FG_BLACK : FG_WHITE) + (bottom ? BG_BLACK : BG_WHITE) + '▀'
    }
    rows.push(row + RESET)
  }
  return rows.join('\n')
}
