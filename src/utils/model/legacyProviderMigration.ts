/**
 * Legacy Provider Migration
 *
 * Pure function that synthesizes provider configs from legacy environment
 * variables for the one-shot runLegacyToFreecodeMigration() at migration time.
 *
 * No side effects: callers pass in the `env` bag to consult. No `process.env`
 * reads, no runtime settings-layer imports.
 */

import type { ProviderConfig } from '../settings/types.js'
import { isEnvTruthy } from '../envUtils.js'
import { stripContextSuffix } from './parseModelString.js'
import {
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_BEDROCK_MODELS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_FOUNDRY_MODELS,
  DEFAULT_VERTEX_MODELS,
} from './providerPresets.js'

/** Return type of synthesizeProvidersFromLegacy */
export interface LegacyMigrationResult {
  providers: Record<string, ProviderConfig>
  defaultModel?: string
  defaultSubagentModel?: string
  defaultSmallFastModel?: string
}

// ── Migration logic ──────────────────────────────────────────────────

/**
 * Generate provider configs from legacy environment variables.
 *
 * Pure function: the caller controls exactly which env bag is consulted.
 * runLegacyToFreecodeMigration() passes `{ ...process.env, ...settings.env }`.
 *
 * @param opts.env - The environment to consult (required).
 * @param opts.oauthTokens - OAuth tokens from secure storage (if available).
 */
export function synthesizeProvidersFromLegacy(opts: {
  env: Record<string, string | undefined>
  oauthTokens?: { accessToken: string } | null
}): LegacyMigrationResult {
  const providers: Record<string, ProviderConfig> = {}
  const { env } = opts
  const getEnv = (key: string): string | undefined => env[key]

  if (isEnvTruthy(getEnv('CLAUDE_CODE_USE_BEDROCK'))) {
    const region = getEnv('AWS_REGION') || getEnv('AWS_DEFAULT_REGION')
    providers['bedrock'] = {
      type: 'bedrock-converse',
      cache: { type: 'none' },
      auth: {
        active: 'aws',
        aws: { region: region || 'us-east-1' },
      },
      models: DEFAULT_BEDROCK_MODELS,
    }
  } else if (isEnvTruthy(getEnv('CLAUDE_CODE_USE_VERTEX'))) {
    const region = getEnv('CLOUD_ML_REGION')
    const projectId = getEnv('ANTHROPIC_VERTEX_PROJECT_ID')
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
  } else if (isEnvTruthy(getEnv('CLAUDE_CODE_USE_FOUNDRY'))) {
    // Resolve Foundry env vars into config so the adapter stays pure
    const foundryResource = getEnv('ANTHROPIC_FOUNDRY_RESOURCE')
    const foundryBaseUrl =
      getEnv('ANTHROPIC_FOUNDRY_BASE_URL') ||
      (foundryResource
        ? `https://${foundryResource}.services.ai.azure.com/anthropic`
        : undefined)
    const foundryApiKey = getEnv('ANTHROPIC_FOUNDRY_API_KEY')
    providers['foundry'] = {
      type: 'foundry',
      ...(foundryBaseUrl ? { baseUrl: foundryBaseUrl } : {}),
      cache: { type: 'none' },
      auth: {
        active: foundryApiKey ? 'apiKey' : 'azure',
        ...(foundryApiKey
          ? { apiKey: { keyEnv: 'ANTHROPIC_FOUNDRY_API_KEY' } }
          : { azure: {} }),
      },
      models: DEFAULT_FOUNDRY_MODELS,
    }
  } else if (isEnvTruthy(getEnv('CLAUDE_CODE_USE_OPENAI'))) {
    // OpenAI/Codex provider — uses openai-responses transform
    providers['codex'] = {
      type: 'openai-responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      cache: { type: 'automatic-prefix' },
      capabilities: { webSearch: true },
      auth: {
        active: 'oauth',
        oauth: { accessToken: '' }, // filled at runtime from Codex OAuth tokens
      },
      models: DEFAULT_CODEX_MODELS,
    }
  } else {
    // Default: Anthropic direct API
    const baseUrl = getEnv('ANTHROPIC_BASE_URL')
    const hasAuthToken = !!getEnv('ANTHROPIC_AUTH_TOKEN')
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

  // Migrate legacy model selection to defaultModel/defaultSubagentModel.
  // Sources: whatever env bag the caller supplied. Caller is responsible for
  // merging process.env / settings.env / settings.model as appropriate.
  // Cannot use parseUserSpecifiedModel() here (registry not yet initialized),
  // so we do simple provider:modelId qualification.
  const defaultProviderName = Object.keys(providers)[0] ?? 'anthropic'

  const qualify = (model: string): string => {
    const bare = stripContextSuffix(model)
    return bare.includes(':') ? bare : `${defaultProviderName}:${bare}`
  }

  const envModel = getEnv('ANTHROPIC_MODEL')
  const defaultModel = envModel ? qualify(envModel) : undefined

  const envSubagent = getEnv('CLAUDE_CODE_SUBAGENT_MODEL')
  const defaultSubagentModel = envSubagent ? qualify(envSubagent) : undefined

  const envSmallFast =
    getEnv('ANTHROPIC_SMALL_FAST_MODEL') ||
    getEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL')
  const defaultSmallFastModel = envSmallFast ? qualify(envSmallFast) : undefined

  return {
    providers,
    defaultModel,
    defaultSubagentModel,
    defaultSmallFastModel,
  }
}
