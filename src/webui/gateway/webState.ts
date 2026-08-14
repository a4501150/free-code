import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { WebStartOptionsSchema } from './service.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

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
