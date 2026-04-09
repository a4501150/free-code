type WorkerFn = () => Promise<void>

const workers: Record<string, WorkerFn> = {
  async supervisor() {
    // Long-running supervisor loop — runs until SIGTERM
    let running = true
    const onSignal = () => {
      running = false
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)

    try {
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
