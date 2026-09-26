/**
 * withRefreshLock() guards every MCP token-refresh leg against concurrent
 * CC processes sharing the credential store:
 * - if the store already holds a token with >5min life (a peer process
 *   refreshed), refreshAuthorization returns those tokens and the exclusive
 *   work never runs;
 * - otherwise the exclusive work runs with the latest stored entry and the
 *   lock file is released afterwards.
 *
 * Storage is faked (getSecureStorage is mocked before the module under test
 * loads); the lock itself is real, taken under a temp FREECODE_CONFIG_DIR.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type StoredEntry = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

const state: {
  data: { mcpOAuth?: Record<string, StoredEntry> }
} = { data: {} }

mock.module('../../src/utils/secureStorage/index.js', () => ({
  getSecureStorage: () => ({
    name: 'fake',
    read: () => state.data,
    readAsync: async () => state.data,
    update: (fn: (d: unknown) => unknown) => {
      state.data = fn(state.data) as typeof state.data
    },
    delete: () => {
      state.data = {}
    },
  }),
}))

const { ClaudeAuthProvider, getServerKey } =
  await import('../../src/services/mcp/auth.js')

// Restored after each test so the env change does not leak into other files
// (unit tests share one process).
const tmpConfigDir = mkdtempSync(join(tmpdir(), 'mcp-refresh-'))
const savedConfigDir = process.env.FREECODE_CONFIG_DIR

const config = {
  type: 'http' as const,
  url: 'https://mcp.example.com/mcp',
}
const serverKey = getServerKey('test-server', config)

function makeProvider(): ClaudeAuthProvider {
  return new ClaudeAuthProvider('test-server', config, undefined, true)
}

describe('withRefreshLock', () => {
  beforeEach(() => {
    process.env.FREECODE_CONFIG_DIR = tmpConfigDir
  })
  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.FREECODE_CONFIG_DIR
    } else {
      process.env.FREECODE_CONFIG_DIR = savedConfigDir
    }
  })

  test("returns a peer process's fresh tokens without running the refresh", async () => {
    state.data = {
      mcpOAuth: {
        [serverKey]: {
          accessToken: 'peer-token',
          refreshToken: 'peer-refresh',
          expiresAt: Date.now() + 3600_000,
          scope: 'mcp',
        },
      },
    }
    const provider = makeProvider()
    let ranExclusive = false
    ;(
      provider as unknown as { _doRefresh: () => Promise<undefined> }
    )._doRefresh = async () => {
      ranExclusive = true
      return undefined
    }

    const tokens = await provider.refreshAuthorization('stale-refresh')

    expect(ranExclusive).toBe(false)
    expect(tokens?.access_token).toBe('peer-token')
    expect(tokens?.refresh_token).toBe('peer-refresh')
  })

  test('runs the exclusive refresh when the stored token is not fresh, and releases the lock', async () => {
    state.data = {
      mcpOAuth: {
        [serverKey]: {
          accessToken: 'old-token',
          refreshToken: 'stored-refresh',
          expiresAt: Date.now() - 1000,
        },
      },
    }
    const provider = makeProvider()
    let seenRefresh: string | undefined
    ;(
      provider as unknown as {
        _doRefresh: (rt: string) => Promise<{ access_token: string } & object>
      }
    )._doRefresh = async (rt: string) => {
      seenRefresh = rt
      return {
        access_token: 'new-token',
        token_type: 'Bearer',
      }
    }

    const tokens = await provider.refreshAuthorization('stale-refresh')

    // The lock callback must pass the freshest stored refresh token along.
    expect(seenRefresh).toBe('stored-refresh')
    expect(tokens?.access_token).toBe('new-token')

    // Released: a second immediate acquisition by the same lock path works.
    const lockfile = await import('../../src/utils/lockfile.js')
    const release = await lockfile.lock(
      join(
        process.env.FREECODE_CONFIG_DIR!,
        `mcp-refresh-${serverKey.replace(/[^a-zA-Z0-9]/g, '_')}.lock`,
      ),
      { realpath: false },
    )
    await release()
  })
})
