/**
 * Unit tests: JSONC comment-preserving settings helpers.
 */
import { describe, expect, test } from 'bun:test'
import {
  modifyJsoncKey,
  patchJsoncFile,
  safeParseJSONC,
  SETTINGS_DEEP_KEYS,
} from '../../src/utils/json.js'

const FIXTURE = `{
  // my provider config
  "providers": {
    // keep anthropic
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com"
    },
    "claude-ai": {
      "type": "claudeai",
      "auth": { "active": "oauth" }
    }
  },
  /* model default */
  "defaultModel": "anthropic:claude-opus-4-6"
}
`

describe('safeParseJSONC', () => {
  test('parses a JSONC document with line and block comments', () => {
    const out = safeParseJSONC(FIXTURE) as Record<string, unknown>
    expect(out.defaultModel).toBe('anthropic:claude-opus-4-6')
    const providers = out.providers as Record<string, unknown>
    expect(Object.keys(providers).sort()).toEqual(['anthropic', 'claude-ai'])
  })

  test('accepts trailing commas', () => {
    const out = safeParseJSONC('{"a": 1, "b": 2,}') as Record<string, unknown>
    expect(out).toEqual({ a: 1, b: 2 })
  })

  test('returns null on invalid JSONC', () => {
    expect(safeParseJSONC('{oops', false)).toBeNull()
  })

  test('returns null on empty/null input', () => {
    expect(safeParseJSONC('')).toBeNull()
    expect(safeParseJSONC(null)).toBeNull()
    expect(safeParseJSONC(undefined)).toBeNull()
  })
})

describe('modifyJsoncKey', () => {
  test('updates a leaf value and preserves surrounding comments', () => {
    const out = modifyJsoncKey(FIXTURE, ['defaultModel'], 'anthropic:claude-haiku-4-5')
    expect(out).toContain('// my provider config')
    expect(out).toContain('// keep anthropic')
    expect(out).toContain('/* model default */')
    expect(out).toContain('"anthropic:claude-haiku-4-5"')
    expect(out).not.toContain('"anthropic:claude-opus-4-6"')
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    expect(parsed.defaultModel).toBe('anthropic:claude-haiku-4-5')
  })

  test('deletes a key when value is undefined', () => {
    const out = modifyJsoncKey(FIXTURE, ['defaultModel'], undefined)
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    expect('defaultModel' in parsed).toBe(false)
    // Comments attached to *other* keys survive.
    expect(out).toContain('// my provider config')
    expect(out).toContain('// keep anthropic')
    // Note: the leading comment on a deleted key (`/* model default */`)
    // is removed with the key — jsonc-parser treats leading comments as
    // part of the owner node. This is expected behavior.
  })

  test('sets a non-existent nested path (auto-creates parent when present)', () => {
    const start = '{\n  "providers": {}\n}\n'
    const out = modifyJsoncKey(start, ['providers', 'new-one'], {
      type: 'anthropic',
    })
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    const providers = parsed.providers as Record<string, unknown>
    expect(providers['new-one']).toEqual({ type: 'anthropic' })
  })

  test('deleting a non-existent key is a no-op (returns equivalent content)', () => {
    const out = modifyJsoncKey(FIXTURE, ['nothere'], undefined)
    const parsedBefore = safeParseJSONC(FIXTURE)
    const parsedAfter = safeParseJSONC(out)
    expect(parsedAfter).toEqual(parsedBefore)
  })
})

describe('patchJsoncFile', () => {
  test('updating one provider preserves siblings and their comments', () => {
    const out = patchJsoncFile(FIXTURE, {
      providers: {
        'claude-ai': {
          type: 'claudeai',
          auth: { active: 'oauth', oauth: { accessToken: 'tok' } },
        },
      },
    })
    // siblings preserved
    expect(out).toContain('// my provider config')
    expect(out).toContain('// keep anthropic')
    expect(out).toContain('"type": "anthropic"')
    expect(out).toContain('"baseUrl": "https://api.anthropic.com"')
    // claude-ai updated
    expect(out).toContain('"accessToken": "tok"')
    // unrelated top-level key untouched
    expect(out).toContain('/* model default */')
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    const providers = parsed.providers as Record<
      string,
      Record<string, unknown>
    >
    expect(providers.anthropic).toEqual({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    })
    expect(providers['claude-ai']).toMatchObject({
      type: 'claudeai',
    })
  })

  test('updating a top-level scalar leaves the providers block (and comments) untouched', () => {
    const out = patchJsoncFile(FIXTURE, { defaultModel: 'x' })
    expect(out).toContain('// my provider config')
    expect(out).toContain('// keep anthropic')
    expect(out).toContain('"anthropic"')
    expect(out).toContain('"claude-ai"')
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    expect(parsed.defaultModel).toBe('x')
  })

  test('deleting a top-level key preserves comments', () => {
    const out = patchJsoncFile(FIXTURE, { defaultModel: undefined })
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    expect('defaultModel' in parsed).toBe(false)
    expect(out).toContain('// my provider config')
    expect(out).toContain('// keep anthropic')
  })

  test('null/empty content serializes fresh JSON with trailing newline', () => {
    const a = patchJsoncFile(null, { defaultModel: 'x' })
    const b = patchJsoncFile('', { defaultModel: 'x' })
    expect(a).toBe('{\n  "defaultModel": "x"\n}\n')
    expect(b).toBe(a)
  })

  test('always emits a trailing newline', () => {
    const noTrailing = FIXTURE.replace(/\n$/, '')
    const out = patchJsoncFile(noTrailing, { defaultModel: 'x' })
    expect(out.endsWith('\n')).toBe(true)
  })

  test('adding a provider to a file that has no providers block seeds the parent', () => {
    const start = '{\n  "defaultModel": "x"\n}\n'
    const out = patchJsoncFile(start, {
      providers: { anthropic: { type: 'anthropic' } },
    })
    const parsed = safeParseJSONC(out) as Record<string, unknown>
    const providers = parsed.providers as Record<string, unknown>
    expect(providers.anthropic).toEqual({ type: 'anthropic' })
    expect(parsed.defaultModel).toBe('x')
  })

  test('SETTINGS_DEEP_KEYS exposes the expected set', () => {
    expect(SETTINGS_DEEP_KEYS.has('providers')).toBe(true)
    expect(SETTINGS_DEEP_KEYS.has('mcpServers')).toBe(true)
    expect(SETTINGS_DEEP_KEYS.has('permissions')).toBe(true)
    expect(SETTINGS_DEEP_KEYS.has('pluginConfigs')).toBe(true)
    expect(SETTINGS_DEEP_KEYS.has('env')).toBe(true)
    expect(SETTINGS_DEEP_KEYS.has('extraKnownMarketplaces')).toBe(true)
    expect(SETTINGS_DEEP_KEYS.has('defaultModel')).toBe(false)
  })
})
