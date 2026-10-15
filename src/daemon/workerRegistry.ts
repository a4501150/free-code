import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

type WorkerFn = () => Promise<void>

const workers: Record<string, WorkerFn> = {
  async supervisor() {
    // Long-running supervisor — runs until SIGTERM
    let running = true
    let onStop: (() => void) | undefined
    const onSignal = () => {
      running = false
      onStop?.()
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)

    try {
      // Host the WebUI. The control socket is what makes `claude web start`
      // able to return while the server keeps running here.
      const { createSessiondService } = await import('../sessiond/service.js')
      const { startDaemonControlServer } =
        await import('../webui/daemonControl.js')

      const service = createSessiondService()
      const control = startDaemonControlServer({
        start: options => service.start(options),
        stop: async () => {
          await service.stop()
        },
        status: () => service.status,
        // The socket answers `{ok}`; the service throws to fail.
        notifyAssistant: async text => {
          try {
            await service.assistantNotify(text)
            return { ok: true }
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        },
      })

      service.setControlUnbind(() => control.unbind())

      await new Promise<void>(resolve => {
        onStop = resolve
        if (!running) resolve()
      })

      control.stop()
      await service.stop()
    } finally {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      try {
        const pidFile = join(getClaudeConfigHomeDir(), 'daemon.pid')
        const stored = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
        if (stored === process.pid) unlinkSync(pidFile)
      } catch {
        // PID file already gone or belongs to a replacement.
      }
    }
  },
}

export async function runDaemonWorker(kind: string): Promise<void> {
  const worker = workers[kind]
  if (!worker) {
    console.error(`Unknown daemon worker kind: ${kind}`)
    process.exitCode = 1
    return
  }
  await worker()
}
