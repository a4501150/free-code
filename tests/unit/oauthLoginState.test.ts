/**
 * Login-layer resolution tests: which login applies to the active provider,
 * when the user counts as logged in, and where codex tokens get installed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getActiveLoginState } from '../../src/services/oauth/logins/active.js'
import { installCodexLoginTokens } from '../../src/services/oauth/logins/codex.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import {
  readModelSettingsFile,
  writeModelSettingsFile,
} from '../../src/utils/settings/modelSettings.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

function setActive(providers: Record<string, ProviderConfig>): void {
  resetProviderRegistry()
  const [name, config] = Object.entries(providers)[0]!
  initProviderRegistry(providers, {
    defaultModel: config.models[0]
      ? `${name}:${config.models[0].id}`
      : undefined,
  })
}

const HOUR = 60 * 60 * 1000

describe('getActiveLoginState', () => {
  afterEach(() => {
    resetProviderRegistry()
  })

  test('zero providers: no-providers (fresh install)', () => {
    // Empty registry, not the ambient config — this process may have providers.
    initProviderRegistry({})
    expect(getActiveLoginState().mode).toBe('no-providers')
  })

  test('configured bearer provider is never a login state', () => {
    setActive({
      'local-qwen': {
        type: 'openai-chat-completions',
        baseUrl: 'http://localhost:8000/v1',
        auth: { active: 'bearer', bearer: { token: 't' } },
        models: [{ id: 'qwen' }],
      } as ProviderConfig,
    })
    const state = getActiveLoginState()
    expect(state.mode).toBe('configured')
  })

  test('anthropic provider without an auth block falls back to legacy chain', () => {
    setActive({
      anthropic: {
        type: 'anthropic',
        models: [{ id: 'claude-x' }],
      } as ProviderConfig,
    })
    expect(getActiveLoginState().mode).toBe('legacy-anthropic')
  })

  test('codex provider with a live oauth block is logged in', () => {
    setActive({
      codex: {
        type: 'openai-responses',
        auth: {
          active: 'oauth',
          oauth: {
            accessToken: 'at',
            refreshToken: 'rt',
            expiresAt: Date.now() + HOUR,
          },
        },
        models: [{ id: 'gpt-x' }],
      } as ProviderConfig,
    })
    const state = getActiveLoginState()
    expect(
      state.mode === 'login' && state.kind === 'codex' && state.loggedIn,
    ).toBe(true)
  })

  test('expired codex token with a refresh token still counts as logged in', () => {
    setActive({
      codex: {
        type: 'openai-responses',
        auth: {
          active: 'oauth',
          oauth: {
            accessToken: 'at',
            refreshToken: 'rt',
            expiresAt: Date.now() - HOUR,
          },
        },
        models: [{ id: 'gpt-x' }],
      } as ProviderConfig,
    })
    const state = getActiveLoginState()
    expect(state.mode === 'login' && state.loggedIn).toBe(true)
  })

  test('codex oauth slot with an empty access token is not logged in', () => {
    setActive({
      codex: {
        type: 'openai-responses',
        auth: { active: 'oauth', oauth: { accessToken: '' } },
        models: [{ id: 'gpt-x' }],
      } as ProviderConfig,
    })
    const state = getActiveLoginState()
    expect(state.mode === 'login' && state.loggedIn).toBe(false)
  })

  test('anthropic-type provider with a hand-written oauth block is logged in', () => {
    setActive({
      anthropic: {
        type: 'anthropic',
        baseUrl: 'http://proxy.local/claude',
        auth: {
          active: 'oauth',
          oauth: {
            accessToken: 'at',
            refreshToken: 'rt',
            expiresAt: Date.now() + HOUR,
          },
        },
        models: [{ id: 'claude-x' }],
      } as ProviderConfig,
    })
    const state = getActiveLoginState()
    // kind claude-ai; the config block alone satisfies the login state.
    expect(
      state.mode === 'login' && state.kind === 'claude-ai' && state.loggedIn,
    ).toBe(true)
  })
})

describe('installCodexLoginTokens', () => {
  let tmpDir: string
  let prevConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'login-codex-'))
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetProviderRegistry()
  })

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    }
    rmSync(tmpDir, { recursive: true, force: true })
    resetProviderRegistry()
  })

  test('creates the codex slot with preset models when none exists', () => {
    installCodexLoginTokens({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1700000000000,
      accountId: 'acct',
    })
    const providers = readModelSettingsFile()?.providers as Record<
      string,
      {
        type?: string
        auth?: { active?: string; oauth?: Record<string, unknown> }
        models?: unknown[]
      }
    >
    expect(providers.codex.type).toBe('openai-responses')
    expect(providers.codex.auth?.active).toBe('oauth')
    expect(providers.codex.auth?.oauth).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1700000000000,
    })
    expect((providers.codex.models ?? []).length).toBeGreaterThan(0)
  })

  test('reuses an existing oauth-active codex slot instead of duplicating', () => {
    writeModelSettingsFile({
      providers: {
        mycodex: {
          type: 'openai-chat-completions',
          baseUrl: 'http://gateway.local/v1',
          auth: { active: 'oauth', oauth: { accessToken: 'old' } },
          models: [{ id: 'custom-model' }],
        },
      },
    })
    installCodexLoginTokens({
      accessToken: 'new',
      refreshToken: 'rt',
      expiresAt: 1700000000001,
      accountId: 'acct',
    })
    const providers = readModelSettingsFile()?.providers as Record<
      string,
      {
        baseUrl?: string
        auth: { oauth?: { accessToken?: string } }
        models: unknown[]
      }
    >
    expect(providers.codex).toBeUndefined()
    expect(providers.mycodex.baseUrl).toBe('http://gateway.local/v1')
    expect(providers.mycodex.auth.oauth?.accessToken).toBe('new')
    expect(providers.mycodex.models).toEqual([{ id: 'custom-model' }])
  })
})
