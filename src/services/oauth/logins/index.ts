/**
 * OAuth login layer — the unified surface over the supported OAuth systems.
 *
 * Adding a third login (e.g. GitHub) means: a new module here implementing
 * read/install/refresh, a LoginKind entry, and it appears in the /login
 * picker and login-state resolution automatically.
 */
import { resetProviderRegistry } from '../../../utils/model/providerRegistry.js'
import {
  readModelSettingsFile,
  writeModelSettingsFile,
} from '../../../utils/settings/modelSettings.js'
import { getActiveLoginState } from './active.js'
import type { LoginKind } from './types.js'

export { getActiveLoginState, refreshActiveLoginTokens } from './active.js'
export type { ActiveLoginState, LoginKind } from './active.js'
export {
  CODEX_LOGIN_SLOT,
  codexLoginProviderSlots,
  installCodexLoginTokens,
  startCodexLogin,
} from './codex.js'
export {
  CLAUDE_AI_LOGIN_SLOT,
  mirrorClaudeAiOAuthToModelSettings,
} from './claudeAi.js'
export type { ProviderOAuthBlock } from './types.js'

/** Picker metadata for the /login (and onboarding) login chooser. */
export const LOGIN_METHODS: Array<{
  kind: LoginKind
  label: string
  description: string
}> = [
  {
    kind: 'claude-ai',
    label: 'Anthropic (Claude)',
    description: 'Claude subscription or Console account',
  },
  {
    kind: 'codex',
    label: 'OpenAI (ChatGPT)',
    description: 'ChatGPT subscription via Codex',
  },
]

/**
 * Clear every login-owned token block: removes `auth.oauth` from each
 * oauth-active provider slot in modelSettings.json, leaving the provider
 * (and its models) in place so the login state flips back to
 * "not logged in — run /login". Used by /logout.
 */
export function clearLoginProviderTokens(): void {
  const settings = readModelSettingsFile()
  const providers = settings?.providers as
    | Record<string, Record<string, unknown>>
    | undefined
  if (!providers) return

  const cleared: Record<string, unknown> = {}
  for (const [name, provider] of Object.entries(providers)) {
    if (
      (provider.auth as Record<string, unknown> | undefined)?.active === 'oauth'
    ) {
      cleared[name] = { ...provider, auth: { active: 'oauth' } }
    }
  }
  if (Object.keys(cleared).length === 0) return

  writeModelSettingsFile({ providers: cleared })
  resetProviderRegistry()
}

/** True when any supported login is currently usable for the active provider. */
export function isActiveLoginLoggedIn(): boolean {
  const state = getActiveLoginState()
  return state.mode === 'login' ? state.loggedIn : false
}
