/**
 * Legacy Provider Migration
 *
 * Auto-generates provider configs from legacy environment variables
 * when settings.providers is not explicitly configured.
 *
 * This ensures backward compatibility: existing users who rely on
 * ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, etc. continue to work
 * without any config changes.
 */

import type { ProviderConfig, ProviderModelConfig } from '../settings/types.js'
import { isEnvTruthy } from '../envUtils.js'

// ── Default Claude models ────────────────────────────────────────────

const DEFAULT_ANTHROPIC_MODELS: ProviderModelConfig[] = [
  {
    id: 'claude-opus-4-6',
    alias: 'opus',
    label: 'Opus 4.6',
    description: 'Most capable',
    context: '1m',
  },
  {
    id: 'claude-sonnet-4-6',
    alias: 'sonnet',
    label: 'Sonnet 4.6',
    description: 'Fast and capable',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    alias: 'haiku',
    label: 'Haiku 4.5',
    description: 'Fastest',
  },
  {
    id: 'claude-opus-4-5-20251101',
    label: 'Opus 4.5',
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    label: 'Sonnet 4.5',
  },
  {
    id: 'claude-opus-4-1-20250805',
    label: 'Opus 4.1',
  },
  {
    id: 'claude-opus-4-20250514',
    label: 'Opus 4',
  },
  {
    id: 'claude-sonnet-4-20250514',
    label: 'Sonnet 4',
  },
  {
    id: 'claude-3-7-sonnet-20250219',
    label: 'Sonnet 3.7',
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    label: 'Sonnet 3.5 v2',
  },
  {
    id: 'claude-3-5-haiku-20241022',
    label: 'Haiku 3.5',
  },
]

const DEFAULT_BEDROCK_MODELS: ProviderModelConfig[] = [
  {
    id: 'us.anthropic.claude-opus-4-6-v1',
    alias: 'opus',
    label: 'Opus 4.6',
    context: '1m',
  },
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    alias: 'sonnet',
    label: 'Sonnet 4.6',
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    alias: 'haiku',
    label: 'Haiku 4.5',
  },
  {
    id: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    label: 'Opus 4.5',
  },
  {
    id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    label: 'Sonnet 4.5',
  },
  {
    id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    label: 'Opus 4.1',
  },
  {
    id: 'us.anthropic.claude-opus-4-20250514-v1:0',
    label: 'Opus 4',
  },
  {
    id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    label: 'Sonnet 4',
  },
  {
    id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    label: 'Sonnet 3.7',
  },
  {
    id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    label: 'Sonnet 3.5 v2',
  },
  {
    id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    label: 'Haiku 3.5',
  },
]

const DEFAULT_VERTEX_MODELS: ProviderModelConfig[] = [
  {
    id: 'claude-opus-4-6',
    alias: 'opus',
    label: 'Opus 4.6',
    context: '1m',
  },
  {
    id: 'claude-sonnet-4-6',
    alias: 'sonnet',
    label: 'Sonnet 4.6',
  },
  {
    id: 'claude-haiku-4-5@20251001',
    alias: 'haiku',
    label: 'Haiku 4.5',
  },
  {
    id: 'claude-opus-4-5@20251101',
    label: 'Opus 4.5',
  },
  {
    id: 'claude-sonnet-4-5@20250929',
    label: 'Sonnet 4.5',
  },
  {
    id: 'claude-opus-4-1@20250805',
    label: 'Opus 4.1',
  },
  {
    id: 'claude-opus-4@20250514',
    label: 'Opus 4',
  },
  {
    id: 'claude-sonnet-4@20250514',
    label: 'Sonnet 4',
  },
  {
    id: 'claude-3-7-sonnet@20250219',
    label: 'Sonnet 3.7',
  },
  {
    id: 'claude-3-5-sonnet-v2@20241022',
    label: 'Sonnet 3.5 v2',
  },
  {
    id: 'claude-3-5-haiku@20241022',
    label: 'Haiku 3.5',
  },
]

const DEFAULT_FOUNDRY_MODELS: ProviderModelConfig[] = [
  {
    id: 'claude-opus-4-6',
    alias: 'opus',
    label: 'Opus 4.6',
    context: '1m',
  },
  {
    id: 'claude-sonnet-4-6',
    alias: 'sonnet',
    label: 'Sonnet 4.6',
  },
  {
    id: 'claude-haiku-4-5',
    alias: 'haiku',
    label: 'Haiku 4.5',
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
  },
  {
    id: 'claude-opus-4-1',
    label: 'Opus 4.1',
  },
  {
    id: 'claude-opus-4',
    label: 'Opus 4',
  },
  {
    id: 'claude-sonnet-4',
    label: 'Sonnet 4',
  },
  {
    id: 'claude-3-7-sonnet',
    label: 'Sonnet 3.7',
  },
  {
    id: 'claude-3-5-sonnet',
    label: 'Sonnet 3.5',
  },
  {
    id: 'claude-3-5-haiku',
    label: 'Haiku 3.5',
  },
]

const DEFAULT_CODEX_MODELS: ProviderModelConfig[] = [
  {
    id: 'gpt-5.4',
    alias: 'gpt54',
    label: 'GPT-5.4',
    description: 'Latest GPT',
  },
  {
    id: 'gpt-5.3-codex',
    alias: 'gpt53codex',
    label: 'GPT-5.3 Codex',
    description: 'Frontier agentic coding',
  },
  {
    id: 'gpt-5.4-mini',
    alias: 'gpt54mini',
    label: 'GPT-5.4 Mini',
    description: 'Fast GPT',
  },
]

// ── Migration logic ──────────────────────────────────────────────────

/**
 * Generate provider configs from legacy environment variables.
 * Called at startup when settings.providers is absent.
 *
 * @param opts.oauthTokens - OAuth tokens from secure storage (if available).
 *   Passed in by the registry's lazy init to avoid circular deps.
 */
export function migrateFromLegacyEnvVars(opts?: {
  oauthTokens?: { accessToken: string } | null
}): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {}

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
    providers['bedrock'] = {
      type: 'bedrock-converse',
      cache: { type: 'none' },
      auth: {
        active: 'aws',
        aws: { region: region || 'us-east-1' },
      },
      models: DEFAULT_BEDROCK_MODELS,
    }
  } else if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    const region = process.env.CLOUD_ML_REGION
    const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID
    providers['vertex'] = {
      type: 'vertex',
      cache: { type: 'explicit-breakpoint' },
      auth: {
        active: 'gcp',
        gcp: {
          ...(region ? { region } : {}),
          ...(projectId ? { projectId } : {}),
        },
      },
      models: DEFAULT_VERTEX_MODELS,
    }
  } else if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    providers['foundry'] = {
      type: 'foundry',
      cache: { type: 'none' },
      auth: {
        active: 'azure',
        azure: {},
      },
      models: DEFAULT_FOUNDRY_MODELS,
    }
  } else if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    // OpenAI/Codex provider — uses openai-responses transform
    providers['codex'] = {
      type: 'openai-responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      cache: { type: 'automatic-prefix' },
      auth: {
        active: 'oauth',
        oauth: { accessToken: '' }, // filled at runtime from Codex OAuth tokens
      },
      models: DEFAULT_CODEX_MODELS,
    }
  } else {
    // Default: Anthropic direct API
    const baseUrl = process.env.ANTHROPIC_BASE_URL
    const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN
    let auth: ProviderConfig['auth']
    if (opts?.oauthTokens?.accessToken) {
      // Claude.ai OAuth subscriber — tokens from secure storage
      auth = {
        active: 'oauth',
        oauth: {
          accessToken: opts.oauthTokens.accessToken,
        },
      }
    } else if (hasAuthToken) {
      auth = {
        active: 'bearer',
        bearer: { tokenEnv: 'ANTHROPIC_AUTH_TOKEN' },
      }
    } else {
      auth = {
        active: 'apiKey',
        apiKey: { keyEnv: 'ANTHROPIC_API_KEY' },
      }
    }

    providers['anthropic'] = {
      type: 'anthropic',
      ...(baseUrl ? { baseUrl } : {}),
      cache: { type: 'explicit-breakpoint' },
      auth,
      models: DEFAULT_ANTHROPIC_MODELS,
    }
  }

  return providers
}

// Re-export default model lists for use in other modules
export {
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_BEDROCK_MODELS,
  DEFAULT_VERTEX_MODELS,
  DEFAULT_FOUNDRY_MODELS,
  DEFAULT_CODEX_MODELS,
}
