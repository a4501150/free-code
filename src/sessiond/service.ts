/**
 * The sessiond service: one serve process plus its tunnel.
 *
 * Successor of the gateway's service wrapper. Same contract on the control
 * socket (`web.start|stop|status`), same health-check-before-tunnel-publish
 * ordering, same `restart_ready` handoff — what changed is the thing being
 * wrapped: sessiond hosts sessions in-process (HostedSession) instead of
 * spawning headless CLI children, so `sessionDefaults` feeds every hosted
 * session directly and the assistant is just another hosted core.
 */

import { createCloudflareNamedTunnelProvider } from '../webui/tunnel/cloudflareNamedTunnelProvider.js'
import { createCloudflareTunnelProvider } from '../webui/tunnel/cloudflareTunnelProvider.js'
import { createCommandTunnelProvider } from '../webui/tunnel/commandTunnelProvider.js'
import { createLocalTunnelProvider } from '../webui/tunnel/localTunnelProvider.js'
import { readTunnelSettings } from '../webui/tunnel/tunnelConfig.js'
import type { TunnelHandle, TunnelProvider } from '../webui/tunnel/types.js'
import { startSessiondServe, type ServeAssistantStatus } from './serve.js'
import type { SessionDefaults } from './registry.js'
import {
  writeWebState,
  subdomainOf,
  type WebStartOptions,
} from '../webui/gateway/webState.js'
import {
  bootstrapAssistantSession,
  writeAssistantResumeId,
} from './assistant.js'
import { startGracefulRestart } from './restart.js'

export type { WebStartOptions }
export { WebStartOptionsSchema } from '../webui/gateway/webState.js'

export type WebStatus = {
  running: boolean
  url?: string
  publicUrl?: string
  tunnel?: string
  tunnelError?: string
  startedAt?: number
  /**
   * The machine's one assistant session: a state while the service runs
   * (`web.status` pollers wait for `live` or bail on `gone`), null when the
   * service is stopped.
   */
  assistant?: ServeAssistantStatus | null
}

function providerFor(options: WebStartOptions): TunnelProvider | null {
  switch (options.tunnel) {
    case 'none':
      return null
    case 'command':
      if (!options.tunnelCommand) {
        throw new Error('--tunnel command requires --tunnel-command')
      }
      return createCommandTunnelProvider(options.tunnelCommand)
    case 'cloudflared': {
      // A configured `tunnel` block switches to a named tunnel with a static
      // hostname; without one, the account-free quick tunnel is used.
      const settings = readTunnelSettings()
      if (settings?.provider === 'cloudflare') {
        return createCloudflareNamedTunnelProvider(settings)
      }
      return createCloudflareTunnelProvider()
    }
    case 'localtunnel':
      return createLocalTunnelProvider({
        subdomain: options.subdomain,
        host: options.tunnelHost,
      })
  }
}

/**
 * What each hosted session starts with, from the operator's `web start`
 * flags. The mode and the tool allow/deny lists transfer into the
 * per-session permission context the registry assembles; `settings` and
 * `settingSources` have no hosted channel yet.
 */
function sessionDefaultsFor(
  options: WebStartOptions,
): SessionDefaults | undefined {
  if (
    !options.permissionMode &&
    !options.allowedTools &&
    !options.disallowedTools
  )
    return undefined
  return {
    ...(options.permissionMode
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools
      ? { disallowedTools: options.disallowedTools }
      : {}),
  }
}

/**
 * The sessiond service: one loopback serve plus an optional tunnel.
 *
 * Held by the daemon supervisor so it outlives the terminal that started it.
 */
export function createSessiondService() {
  let serve: Awaited<ReturnType<typeof startSessiondServe>> | null = null
  let tunnel: TunnelHandle | null = null
  let tunnelAbort: AbortController | null = null
  let startedAt = 0
  let publicUrl: string | null = null
  let tunnelName: string | undefined
  let tunnelError: string | undefined
  let assistantSessionId: string | undefined
  let controlUnbind: (() => void) | null = null

  function status(): WebStatus {
    if (!serve) return { running: false, assistant: null }
    return {
      running: true,
      url: serve.url,
      ...(publicUrl ? { publicUrl } : {}),
      ...(tunnelName ? { tunnel: tunnelName } : {}),
      ...(tunnelError ? { tunnelError } : {}),
      startedAt,
      assistant: serve.assistantStatus(),
    }
  }

  async function start(options: WebStartOptions): Promise<WebStatus> {
    if (serve) return status()

    serve = await startSessiondServe({
      port: options.port,
      sessionDefaults: sessionDefaultsFor(options),
      // The assistant bootstrap is about to begin: the status reads
      // `starting` until setAssistant settles it live or gone.
      assistantPending: true,
      onRestart: () => {
        const s = serve
        if (!s) return
        startGracefulRestart({
          unbindControl: () => controlUnbind?.(),
          broadcast: frame => s.broadcastRestartReady(frame),
        })
      },
    })
    startedAt = Date.now()

    // The assistant bootstrap must not hold `web.start` hostage for the
    // tunnel's sake, but it does run before the health check: a serve whose
    // one extra session failed to start still serves every other session.
    try {
      const entry = await bootstrapAssistantSession(
        serve.registry,
        sessionDefaultsFor(options),
      )
      assistantSessionId = entry?.sessionId
      serve.setAssistant(entry ? entry.sessionId : null)
    } catch {
      serve.setAssistant(null)
    }

    tunnelName = undefined
    tunnelError = undefined
    // Provider construction can fail too (an invalid `tunnel` settings
    // block), so it sits inside the same guard: a broken tunnel config
    // must still leave the loopback server serving.
    try {
      const provider = providerFor(options)
      if (provider) {
        tunnelName = provider.name
        // Start the tunnel only after the loopback server answers, so it
        // never publishes a URL that 502s.
        const health = await fetch(`${serve.url}/`, {
          headers: { connection: 'close' },
        }).catch(() => null)
        if (!health?.ok) {
          throw new Error('the local server did not answer its health check')
        }
        tunnelAbort = new AbortController()
        const handle = await provider.start({
          port: serve.port,
          signal: tunnelAbort.signal,
        })
        tunnel = handle
        publicUrl = handle.publicUrl
        serve.setPublicUrl(handle.publicUrl)
      }
    } catch (err) {
      tunnelError = err instanceof Error ? err.message : String(err)
    }

    writeWebState({
      options,
      subdomain: subdomainOf(publicUrl ?? undefined) ?? options.subdomain,
    })
    return status()
  }

  async function stop(): Promise<WebStatus> {
    const final = status()
    // The resume pointer first: the same chat survives the restart even
    // though every hosted session — the assistant included — dies here.
    if (assistantSessionId) {
      await writeAssistantResumeId(assistantSessionId)
    }
    tunnelAbort?.abort()
    await tunnel?.close().catch(() => {})
    tunnel = null
    tunnelAbort = null
    await serve?.stop()
    serve = null
    publicUrl = null
    return final
  }

  return {
    start,
    stop,
    get status(): WebStatus {
      return status()
    },
    setControlUnbind(fn: () => void) {
      controlUnbind = fn
    },
    /**
     * Injects an external event into the assistant session as a prompt turn.
     * The in-process equivalent of the gateway's surface-token POST: a
     * starting assistant gets a short grace, a gone one is a plain failure.
     */
    async assistantNotify(text: string): Promise<void> {
      const s = serve
      if (!s) throw new Error('the web server is not running')
      const deadline = Date.now() + 10_000
      for (;;) {
        const st = s.assistantStatus()
        if (st.state === 'live') {
          const entry = s.registry.bySessionId(st.sessionId)
          if (entry) {
            await entry.hosted.submit(text, { delivery: 'next' })
            return
          }
        }
        if (st.state === 'gone') throw new Error('no assistant session')
        if (Date.now() >= deadline) {
          throw new Error('the assistant did not become ready')
        }
        await Bun.sleep(250)
      }
    },
  }
}

export type SessiondService = ReturnType<typeof createSessiondService>
