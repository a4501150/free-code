import { spawn } from 'child_process'

export type RestartReadyFrame = {
  type: 'restart_ready'
  publicUrl: string | null
  localUrl: string | null
}

/**
 * Graceful restart: keep the old gateway alive while the replacement starts,
 * then push the new URLs to every connected browser before exiting.
 *
 * 1. Release the daemon control socket so the new supervisor can bind it.
 * 2. Spawn a new supervisor from the current executable.
 * 3. Send `web.start` with the persisted options.
 * 4. Wait for the new tunnel URL.
 * 5. Broadcast the URL to all browsers.
 * 6. Exit the old process.
 *
 * Imports that touch `service.ts` or `daemonControl.ts` are dynamic, because
 * `gatewayServer.ts` imports this file and `service.ts` imports
 * `gatewayServer.ts`.
 */
export async function gracefulRestart(ctx: {
  unbindControl: () => void
  broadcast: (frame: RestartReadyFrame) => void
}): Promise<void> {
  const { readWebState } = await import('./webState.js')
  const { sendDaemonControl } = await import('../daemonControl.js')

  const previous = readWebState()
  const options = previous
    ? {
        ...previous.options,
        ...(previous.subdomain ? { subdomain: previous.subdomain } : {}),
      }
    : { tunnel: 'cloudflared' as const }

  ctx.unbindControl()

  const child = spawn(process.execPath, ['--daemon-worker', 'supervisor'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  // Wait for the new daemon to bind the control socket.
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100)
    if (await sendDaemonControl({ kind: 'web.status' }, 2000)) break
  }

  // Tell the new daemon to start its gateway and tunnel.
  const result = await sendDaemonControl(
    { kind: 'web.start', options },
    60_000,
  )

  const publicUrl = result?.ok ? result.status.publicUrl ?? null : null
  const localUrl = result?.ok ? result.status.url ?? null : null

  ctx.broadcast({ type: 'restart_ready', publicUrl, localUrl })

  // Let the WebSocket frame flush before exiting.
  await Bun.sleep(500)
  process.exit(0)
}

/**
 * Fire-and-forget wrapper. The old gateway stays alive during the handoff;
 * errors are swallowed because the process exits either way.
 */
export function startGracefulRestart(ctx: {
  unbindControl: () => void
  broadcast: (frame: RestartReadyFrame) => void
}): void {
  void gracefulRestart(ctx).catch(() => {
    process.exit(1)
  })
}
