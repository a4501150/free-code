import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * The `web start` options, defined here because this file is the state the
 * restart replays: the service and the control socket both read the schema
 * from the persisted store, so no import cycle can leave it undefined at
 * module evaluation time.
 */
export const WebStartOptionsSchema = z.object({
  port: z.number().int().min(0).max(65535).optional(),
  tunnel: z
    .enum(['cloudflared', 'localtunnel', 'command', 'none'])
    .default('cloudflared'),
  tunnelCommand: z.string().optional(),
  tunnelHost: z.string().optional(),
  subdomain: z.string().optional(),

  /**
   * Permission settings the serve process hands to every hosted session.
   *
   * A hosted core otherwise loads only the disk settings for the session's
   * own directory, so anything the operator chose here would be lost.
   * `bypassPermissions` is absent on purpose: the browser is reachable
   * behind one password, and the surface refuses that mode for the same
   * reason.
   */
  permissionMode: z.enum(['default', 'acceptEdits', 'plan']).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  settings: z.string().optional(),
  settingSources: z.string().optional(),
})

export type WebStartOptions = z.infer<typeof WebStartOptionsSchema>

const WebStateSchema = z.object({
  options: WebStartOptionsSchema,
  /**
   * The hostname label the tunnel last handed out. Restarting asks for it
   * again, which is what keeps a URL already open on a phone working.
   */
  subdomain: z.string().optional(),
})

export type WebState = z.infer<typeof WebStateSchema>

function statePath(): string {
  return join(getClaudeConfigHomeDir(), 'webui', 'state.json')
}

/** The tunnel's first hostname label, which is what providers let you request. */
export function subdomainOf(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) return undefined
  try {
    const label = new URL(publicUrl).hostname.split('.')[0]
    return label || undefined
  } catch {
    return undefined
  }
}

export function readWebState(): WebState | null {
  try {
    const parsed = WebStateSchema.safeParse(
      JSON.parse(readFileSync(statePath(), 'utf-8')),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeWebState(state: WebState): void {
  const path = statePath()
  mkdirSync(join(getClaudeConfigHomeDir(), 'webui'), {
    recursive: true,
    mode: DIR_MODE,
  })
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: FILE_MODE })
  chmodSync(path, FILE_MODE)
}
