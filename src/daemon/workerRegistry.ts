import { feature } from 'bun:bundle'

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
      if (feature('WEBUI')) {
        // Host the WebUI. The control socket is what makes `claude web start`
        // able to return while the server keeps running here.
        const { createWebService } = await import('../webui/gateway/service.js')
        const { startDaemonControlServer } =
          await import('../webui/daemonControl.js')

        const service = createWebService()
        const control = startDaemonControlServer({
          start: options => service.start(options),
          stop: () => service.stop(),
          status: () => service.status,
        })

        await new Promise<void>(resolve => {
          onStop = resolve
          if (!running) resolve()
        })

        control.stop()
        await service.stop()
        return
      }

      while (running) {
        // Sleep 5 seconds between ticks
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5_000)
          // Allow the event loop to exit if signal received
          if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref()
          }
          if (!running) resolve()
        })
      }
    } finally {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
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
