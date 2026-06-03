import { readFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'

// .strip() — don't persist internal-only fields (mycro_deployments etc.) to disk
const ModelCapabilitySchema = z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strip()

const CacheFileSchema = z.object({
    models: z.array(ModelCapabilitySchema),
    timestamp: z.number(),
  })

export type ModelCapability = z.infer<typeof ModelCapabilitySchema>

function getCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'model-capabilities.json')
}

function isModelCapabilitiesEligible(): boolean {
  return false
}

// Keyed on cache path so tests that set CLAUDE_CONFIG_DIR get a fresh read
const loadCache = memoize(
  (path: string): ModelCapability[] | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getContextWindowForModel
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema.safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data.models : null
    } catch {
      return null
    }
  },
  path => path,
)

export function getModelCapability(model: string): ModelCapability | undefined {
  if (!isModelCapabilitiesEligible()) return undefined
  const cached = loadCache(getCachePath())
  if (!cached || cached.length === 0) return undefined
  const m = model.toLowerCase()
  const exact = cached.find(c => c.id.toLowerCase() === m)
  if (exact) return exact
  return cached.find(c => m.includes(c.id.toLowerCase()))
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
}
