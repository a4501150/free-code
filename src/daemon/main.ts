import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'

const PID_FILE = join(homedir(), '.claude', 'daemon.pid')

function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (Number.isNaN(pid)) return null
    // Check if process is still running
    try {
      process.kill(pid, 0)
      return pid
    } catch {
      // Process not running, clean up stale PID file
      try {
        unlinkSync(PID_FILE)
      } catch {
        // ignore
      }
      return null
    }
  } catch {
    return null
  }
}

function printUsage(): void {
  console.log('Usage: claude daemon <command>')
  console.log('')
  console.log('Commands:')
  console.log('  start   Start the daemon supervisor')
  console.log('  stop    Stop the running daemon')
  console.log('  status  Show daemon status')
  console.log('  list    List active workers')
}

async function startDaemon(): Promise<void> {
  const existingPid = readPid()
  if (existingPid) {
    console.log(`Daemon already running (PID ${existingPid})`)
    return
  }

  const { spawn } = await import('child_process')
  const child = spawn(process.execPath, ['--daemon-worker', 'supervisor'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), 'utf-8')
    console.log(`Daemon started (PID ${child.pid})`)
  } else {
    console.error('Failed to start daemon')
    process.exitCode = 1
  }
}

function stopDaemon(): void {
  const pid = readPid()
  if (!pid) {
    console.log('Daemon is not running')
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
    try {
      unlinkSync(PID_FILE)
    } catch {
      // ignore
    }
    console.log(`Daemon stopped (PID ${pid})`)
  } catch {
    console.error(`Failed to stop daemon (PID ${pid})`)
    process.exitCode = 1
  }
}

function showStatus(): void {
  const pid = readPid()
  if (pid) {
    console.log(`Daemon is running (PID ${pid})`)
  } else {
    console.log('Daemon is not running')
  }
}

function listWorkers(): void {
  const pid = readPid()
  if (!pid) {
    console.log('Daemon is not running')
    return
  }
  console.log('Active workers:')
  console.log(`  supervisor (PID ${pid})`)
}

export async function daemonMain(args: string[]): Promise<void> {
  const command = args[0]

  switch (command) {
    case 'start':
      await startDaemon()
      break
    case 'stop':
      stopDaemon()
      break
    case 'status':
      showStatus()
      break
    case 'list':
      listWorkers()
      break
    default:
      printUsage()
      break
  }
}
