import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  buildSetCookie,
  createLoginThrottle,
  csrfMatches,
  csrfTokenFor,
  issueSessionToken,
  parseCookies,
  readAuthFile,
  verifyPassword,
  verifySessionToken,
  writeAuthFile,
} from '../../src/webui/gateway/auth.js'
import { validatePublicUrl } from '../../src/webui/tunnel/types.js'
import {
  listDirectories,
  PathError,
  validateSessionCwd,
} from '../../src/webui/gateway/directories.js'
import { applyEvent, emptyView } from '../../src/webui/client/store.js'
import {
  diffSnapshots,
  toWireSnapshot,
} from '../../src/webui/protocol/transcriptWire.js'
import { buildSubmitValue } from '../../src/webui/attach/runtime.js'
import {
  parseQuestions,
  serializeAnswer,
} from '../../src/webui/client/components/QuestionTray.js'
import { approvalInput } from '../../src/webui/client/components/PlanTray.js'
import type { DomainUserContentBlock } from '../../src/types/domain.js'
import type { Message } from '../../src/types/message.js'
import type { UUID } from 'crypto'

let configDir: string
let previous: string | undefined

beforeEach(() => {
  previous = process.env.FREECODE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'webui-gw-unit-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previous === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})

describe('auth storage', () => {
  test('stores the password hashed and owner-only', async () => {
    await writeAuthFile('a-long-enough-password')
    const auth = readAuthFile()
    expect(auth).not.toBeNull()
    expect(auth!.passwordHash).not.toContain('a-long-enough-password')

    const mode = statSync(join(configDir, 'webui', 'auth.json')).mode & 0o777
    expect(mode).toBe(0o600)
    const dirMode = statSync(join(configDir, 'webui')).mode & 0o777
    expect(dirMode).toBe(0o700)
  })

  test('verifies the right password and rejects the wrong one', async () => {
    const auth = await writeAuthFile('a-long-enough-password')
    expect(await verifyPassword(auth, 'a-long-enough-password')).toBe(true)
    expect(await verifyPassword(auth, 'nearly-the-password')).toBe(false)
  })

  test('mints a distinct signing secret per write', async () => {
    const first = await writeAuthFile('a-long-enough-password')
    const second = await writeAuthFile('a-long-enough-password')
    expect(first.signingSecret).not.toBe(second.signingSecret)
  })
})

describe('session tokens', () => {
  test('accepts a token it just issued', async () => {
    const auth = await writeAuthFile('a-long-enough-password')
    expect(verifySessionToken(auth, issueSessionToken(auth))).not.toBeNull()
  })

  test('rejects a tampered payload', async () => {
    const auth = await writeAuthFile('a-long-enough-password')
    const token = issueSessionToken(auth)
    const [body, signature] = token.split('.')
    const forged = `${Buffer.from(
      JSON.stringify({ iat: Date.now(), jti: 'forged' }),
    ).toString('base64url')}.${signature}`
    expect(forged).not.toBe(token)
    expect(verifySessionToken(auth, forged)).toBeNull()
    expect(body).toBeTruthy()
  })

  test('rejects a token signed with another secret', async () => {
    const first = await writeAuthFile('a-long-enough-password')
    const token = issueSessionToken(first)
    const second = await writeAuthFile('a-long-enough-password')
    expect(verifySessionToken(second, token)).toBeNull()
  })

  test('rejects a token that is too old', async () => {
    const auth = await writeAuthFile('a-long-enough-password')
    const stale = `${Buffer.from(
      JSON.stringify({ iat: Date.now() - 30 * 24 * 60 * 60 * 1000, jti: 'x' }),
    ).toString('base64url')}`
    // Sign it properly, so age is the only thing wrong.
    const { createHmac } = await import('crypto')
    const signature = createHmac('sha256', auth.signingSecret)
      .update(stale)
      .digest('base64url')
    expect(verifySessionToken(auth, `${stale}.${signature}`)).toBeNull()
  })

  test('rejects a missing or malformed token', async () => {
    const auth = await writeAuthFile('a-long-enough-password')
    expect(verifySessionToken(auth, undefined)).toBeNull()
    expect(verifySessionToken(auth, 'nodot')).toBeNull()
    expect(verifySessionToken(auth, '.onlysignature')).toBeNull()
  })
})

describe('csrf', () => {
  test('binds to the session token', async () => {
    const auth = await writeAuthFile('a-long-enough-password')
    const first = issueSessionToken(auth)
    const second = issueSessionToken(auth)
    const csrf = csrfTokenFor(auth, first)

    expect(csrfMatches(auth, first, csrf)).toBe(true)
    // A token from another login must not authorize this one.
    expect(csrfMatches(auth, second, csrf)).toBe(false)
    expect(csrfMatches(auth, first, null)).toBe(false)
    expect(csrfMatches(auth, first, 'forged')).toBe(false)
  })
})

describe('cookies', () => {
  test('sets HttpOnly and SameSite=Strict, and Secure only when tunneled', () => {
    const local = buildSetCookie('token', false)
    expect(local).toContain('HttpOnly')
    expect(local).toContain('SameSite=Strict')
    expect(local).not.toContain('Secure')
    expect(buildSetCookie('token', true)).toContain('Secure')
  })

  test('parses a cookie header', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' })
    expect(parseCookies(null)).toEqual({})
  })
})

describe('login throttle', () => {
  test('blocks an address after its budget and keeps a global ceiling', () => {
    const throttle = createLoginThrottle({
      perAddress: 2,
      global: 3,
      windowMs: 60_000,
    })

    expect(throttle.check('1.1.1.1')).toBe(true)
    throttle.record('1.1.1.1')
    throttle.record('1.1.1.1')
    expect(throttle.check('1.1.1.1')).toBe(false)

    // A different address still has its own budget, until the global ceiling.
    expect(throttle.check('2.2.2.2')).toBe(true)
    throttle.record('2.2.2.2')
    expect(throttle.check('3.3.3.3')).toBe(false)
  })

  test('clears an address after a success', () => {
    const throttle = createLoginThrottle({
      perAddress: 1,
      global: 99,
      windowMs: 60_000,
    })
    throttle.record('1.1.1.1')
    expect(throttle.check('1.1.1.1')).toBe(false)
    throttle.reset('1.1.1.1')
    expect(throttle.check('1.1.1.1')).toBe(true)
  })
})

describe('tunnel url validation', () => {
  test('accepts https and normalizes to an origin', () => {
    expect(validatePublicUrl('https://x.example/')).toBe('https://x.example')
    expect(validatePublicUrl('  https://x.example  ')).toBe('https://x.example')
  })

  test('refuses anything that is not https', () => {
    expect(() => validatePublicUrl('http://x.example')).toThrow()
    expect(() => validatePublicUrl('ws://x.example')).toThrow()
    expect(() => validatePublicUrl('not a url')).toThrow()
  })
})

function userMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid: uuid as UUID,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  }
}

describe('transcript wire', () => {
  test('flattens messages and drops progress events', () => {
    const snapshot = toWireSnapshot([
      userMessage('11111111-1111-1111-1111-111111111111', 'hello'),
      {
        type: 'progress',
        uuid: '22222222-2222-2222-2222-222222222222' as UUID,
        timestamp: new Date().toISOString(),
        toolUseID: 'tool-1',
        data: {} as never,
      },
    ])
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]!.kind).toBe('user')
    expect(snapshot.order).toEqual([snapshot.items[0]!.id])
  })

  test('reports no patch when nothing changed', () => {
    const messages = [userMessage('11111111-1111-1111-1111-111111111111', 'a')]
    const first = toWireSnapshot(messages)
    const second = toWireSnapshot(messages)
    expect(diffSnapshots(first, second)).toBeNull()
  })

  test('expresses an append as orderAppend rather than a whole order', () => {
    const a = userMessage('11111111-1111-1111-1111-111111111111', 'a')
    const b = userMessage('22222222-2222-2222-2222-222222222222', 'b')
    const patch = diffSnapshots(toWireSnapshot([a]), toWireSnapshot([a, b]))
    expect(patch?.type).toBe('delta')
    if (patch?.type === 'delta') {
      expect(patch.orderAppend).toHaveLength(1)
      expect(patch.order).toBeUndefined()
      expect(patch.upsert).toHaveLength(1)
    }
  })

  test('sends a full order when messages are removed from the middle', () => {
    const a = userMessage('11111111-1111-1111-1111-111111111111', 'a')
    const b = userMessage('22222222-2222-2222-2222-222222222222', 'b')
    const c = userMessage('33333333-3333-3333-3333-333333333333', 'c')
    const patch = diffSnapshots(
      toWireSnapshot([a, b, c]),
      toWireSnapshot([a, c]),
    )
    expect(patch?.type).toBe('delta')
    if (patch?.type === 'delta') {
      expect(patch.remove).toHaveLength(1)
      expect(patch.order).toHaveLength(2)
    }
  })

  test('changes an item revision when its text changes', () => {
    const before = toWireSnapshot([
      userMessage('11111111-1111-1111-1111-111111111111', 'a'),
    ])
    const after = toWireSnapshot([
      userMessage('11111111-1111-1111-1111-111111111111', 'a changed'),
    ])
    expect(before.items[0]!.rev).not.toBe(after.items[0]!.rev)
    const patch = diffSnapshots(before, after)
    if (patch?.type === 'delta') expect(patch.upsert).toHaveLength(1)
  })

  function imageMessage(uuid: string, count: number, text?: string): Message {
    const blocks = Array.from({ length: count }, () => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'A'.repeat(400),
      },
    }))
    return {
      type: 'user',
      uuid: uuid as UUID,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: text ? [...blocks, { type: 'text', text }] : blocks,
      },
    }
  }

  test('numbers image blocks per message and withholds the bytes', () => {
    const snapshot = toWireSnapshot([
      imageMessage('11111111-1111-1111-1111-111111111111', 2, 'look'),
    ])
    const images = snapshot.items.filter(item => item.image)
    expect(images.map(item => item.text)).toEqual(['[image 1]', '[image 2]'])
    expect(images[0]!.image).toEqual({ mediaType: 'image/png', bytes: 400 })

    // The whole point of the metadata-only item: a phone must not pull every
    // image down with the transcript.
    expect(JSON.stringify(snapshot)).not.toContain('A'.repeat(400))
  })

  test('holds an image revision steady across publishes', () => {
    const message = imageMessage('11111111-1111-1111-1111-111111111111', 1)
    expect(
      diffSnapshots(toWireSnapshot([message]), toWireSnapshot([message])),
    ).toBeNull()
  })
})

describe('submit value', () => {
  test('puts images first and the prompt text last', () => {
    // Two readers depend on this order: the prompt string comes from the last
    // block when it is text, and slash detection reads the first text block.
    const value = buildSubmitValue('describe these', [
      { mediaType: 'image/png', data: 'aaa' },
      { mediaType: 'image/jpeg', data: 'bbb' },
    ])
    expect(Array.isArray(value)).toBe(true)
    expect(
      (value as DomainUserContentBlock[]).map(block => block.type),
    ).toEqual(['image', 'image', 'text'])
  })

  test('sends a bare string when there are no images', () => {
    expect(buildSubmitValue('hello', undefined)).toBe('hello')
    expect(buildSubmitValue('hello', [])).toBe('hello')
  })

  test('omits the text block when only images were sent', () => {
    const value = buildSubmitValue('', [{ mediaType: 'image/png', data: 'a' }])
    expect(
      (value as DomainUserContentBlock[]).map(block => block.type),
    ).toEqual(['image'])
  })
})

describe('question answers', () => {
  const single = {
    question: 'Which one?',
    header: 'Pick',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ],
  }

  test('answers a single select with the chosen label', () => {
    expect(serializeAnswer(single, { labels: ['B'], other: '' })).toBe('B')
  })

  test('joins a multi select with a comma, as the terminal does', () => {
    expect(
      serializeAnswer(
        { ...single, multiSelect: true },
        { labels: ['A', 'B'], other: '' },
      ),
    ).toBe('A, B')
  })

  test('uses the typed text when Other is chosen', () => {
    expect(serializeAnswer(single, { labels: ['Other'], other: '  C  ' })).toBe(
      'C',
    )
  })

  test('reports nothing chosen as an empty answer', () => {
    expect(serializeAnswer(single, { labels: [], other: '' })).toBe('')
  })

  test('reads the questions off a permission request input', () => {
    expect(parseQuestions({ questions: [single] })).toHaveLength(1)
    expect(parseQuestions({})).toEqual([])
    expect(parseQuestions({ questions: 'nope' })).toEqual([])
  })
})

describe('plan approval', () => {
  test('drops the plan so the tool does not report a user edit', () => {
    // The tool sets planWasEdited from the presence of `plan`, and reading it
    // back from disk is what the terminal relies on.
    const input = { plan: 'do the thing', planFilePath: '/tmp/p.md' }
    expect(approvalInput(input)).toEqual({ planFilePath: '/tmp/p.md' })
  })

  test('leaves something behind, because an empty input means "use the original"', () => {
    expect(
      Object.keys(approvalInput({ plan: 'x', planFilePath: '/p' })).length,
    ).toBeGreaterThan(0)
  })
})

describe('client store', () => {
  const snapshotEvent = {
    kind: 'snapshot' as const,
    meta: {
      pid: 1,
      processNonce: 'n',
      sessionId: 's',
      sessionEpoch: 0,
      cwd: '/tmp',
      startedAt: 1,
      state: 'idle' as const,
    },
    transcript: { items: [], order: [] },
    permissions: [],
    todos: [],
    models: [{ value: 'claude-opus-5', label: 'Opus 5' }],
  }

  test('ignores an event at or below the last applied sequence', () => {
    let view = applyEvent(emptyView(), 5, snapshotEvent)
    const before = view
    view = applyEvent(view, 5, { kind: 'resync_required' })
    expect(view).toBe(before)
  })

  test('keeps the model list across a later event', () => {
    let view = applyEvent(emptyView(), 1, snapshotEvent)
    expect(view.models).toEqual([{ value: 'claude-opus-5', label: 'Opus 5' }])
    // Models ride only the snapshot, so a metadata update must not drop them.
    view = applyEvent(view, 2, {
      kind: 'meta',
      meta: { ...snapshotEvent.meta, model: 'claude-opus-5' },
    })
    expect(view.models).toHaveLength(1)
    expect(view.meta?.model).toBe('claude-opus-5')
  })

  test('applies a replayed patch exactly once', () => {
    const item = {
      id: 'a:0',
      kind: 'user' as const,
      rev: 'r1',
      timestamp: 't',
      text: 'hello',
    }
    let view = applyEvent(emptyView(), 1, snapshotEvent)
    view = applyEvent(view, 2, {
      kind: 'transcript',
      patch: {
        type: 'delta',
        upsert: [item],
        remove: [],
        orderAppend: ['a:0'],
      },
    })
    // The same sequence arriving again after a reconnect must not duplicate.
    view = applyEvent(view, 2, {
      kind: 'transcript',
      patch: {
        type: 'delta',
        upsert: [item],
        remove: [],
        orderAppend: ['a:0'],
      },
    })
    expect(view.order).toEqual(['a:0'])
  })

  test('clears the transcript when the process switches session', () => {
    let view = applyEvent(emptyView(), 1, snapshotEvent)
    view = applyEvent(view, 2, {
      kind: 'transcript',
      patch: {
        type: 'delta',
        upsert: [
          { id: 'a:0', kind: 'user', rev: 'r', timestamp: 't', text: 'x' },
        ],
        remove: [],
        orderAppend: ['a:0'],
      },
    })
    view = applyEvent(view, 3, {
      kind: 'session_changed',
      sessionId: 'other',
      sessionEpoch: 1,
    })
    expect(view.order).toEqual([])
    expect(view.meta?.sessionId).toBe('other')
    expect(view.meta?.sessionEpoch).toBe(1)
  })

  test('replaces a permission of the same id rather than stacking it', () => {
    const request = {
      requestId: 'r1',
      toolName: 'Bash',
      toolUseId: 't1',
      description: 'run something',
      input: {},
      openedAt: 1,
    }
    let view = applyEvent(emptyView(), 1, snapshotEvent)
    view = applyEvent(view, 2, { kind: 'permission_opened', request })
    view = applyEvent(view, 3, { kind: 'permission_opened', request })
    expect(view.permissions).toHaveLength(1)
    view = applyEvent(view, 4, {
      kind: 'permission_closed',
      requestId: 'r1',
      outcome: 'allow',
    })
    expect(view.permissions).toHaveLength(0)
  })
})

describe('directory listing', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'webui-dirs-'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'Beta'))
    mkdirSync(join(root, 'gamma'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'alpha.txt'), 'not a directory')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function codeOf(run: Promise<unknown>): Promise<string> {
    try {
      await run
      return 'no error'
    } catch (error) {
      return error instanceof PathError ? error.code : String(error)
    }
  }

  test('lists the children of a path that ends in a separator', async () => {
    const listing = await listDirectories(join(root, '/'), true)
    expect(listing.base).toBe(root)
    expect(listing.entries.map(entry => entry.name)).toEqual([
      '.hidden',
      'alpha',
      'Beta',
      'gamma',
    ])
    expect(listing.entries[0]!.path).toBe(join(root, '.hidden'))
    expect(listing.truncated).toBe(false)
  })

  test('treats a trailing segment as a filter on its parent', async () => {
    const listing = await listDirectories(join(root, 'a'), true)
    expect(listing.base).toBe(root)
    expect(listing.entries.map(entry => entry.name)).toEqual(['alpha'])
  })

  test('matches a prefix without regard to case', async () => {
    const listing = await listDirectories(join(root, 'b'), true)
    expect(listing.entries.map(entry => entry.name)).toEqual(['Beta'])
  })

  test('drops a hidden directory when hidden entries are off', async () => {
    const listing = await listDirectories(join(root, '/'), false)
    expect(listing.entries.map(entry => entry.name)).toEqual([
      'alpha',
      'Beta',
      'gamma',
    ])
  })

  test('excludes a plain file', async () => {
    const listing = await listDirectories(join(root, 'alpha'), true)
    expect(listing.entries.map(entry => entry.name)).toEqual(['alpha'])
  })

  test('reports the parent, and null at the root of the volume', async () => {
    expect((await listDirectories(join(root, '/'), true)).parent).toBe(
      dirname(root),
    )
    expect((await listDirectories('/', true)).parent).toBeNull()
  })

  test('lists the home directory for an empty path', async () => {
    const listing = await listDirectories('', true)
    expect(listing.base).toBe(homedir())
  })

  test('sees a directory made after an earlier call', async () => {
    await listDirectories(join(root, '/'), true)
    mkdirSync(join(root, 'delta'))
    const listing = await listDirectories(join(root, '/'), true)
    expect(listing.entries.map(entry => entry.name)).toContain('delta')
  })

  test('follows a link to a directory and keeps the link path', async () => {
    symlinkSync(join(root, 'alpha'), join(root, 'link-dir'))
    symlinkSync(join(root, 'alpha.txt'), join(root, 'link-file'))
    symlinkSync(join(root, 'nowhere'), join(root, 'link-broken'))
    const listing = await listDirectories(join(root, 'link'), true)
    expect(listing.entries).toEqual([
      { name: 'link-dir', path: join(root, 'link-dir') },
    ])
  })

  test('refuses a relative path and a network path', async () => {
    expect(await codeOf(listDirectories('src/', true))).toBe(
      'path_not_absolute',
    )
    expect(await codeOf(listDirectories('//server/share/', true))).toBe(
      'path_not_local',
    )
    expect(await codeOf(listDirectories('\\\\server\\share', true))).toBe(
      'path_not_local',
    )
    expect(await codeOf(listDirectories('/a\0b', true))).toBe('bad_path')
  })

  test('reports a missing directory apart from a plain file', async () => {
    expect(await codeOf(listDirectories(join(root, 'nowhere/'), true))).toBe(
      'directory_not_found',
    )
    expect(await codeOf(listDirectories(join(root, 'alpha.txt/'), true))).toBe(
      'path_not_directory',
    )
  })
})

describe('session directory validation', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'webui-cwd-'))
    mkdirSync(join(root, 'project'))
    writeFileSync(join(root, 'file.txt'), 'not a directory')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function codeOf(run: Promise<unknown>): Promise<string> {
    try {
      await run
      return 'no error'
    } catch (error) {
      return error instanceof PathError ? error.code : String(error)
    }
  }

  test('accepts a directory and a link that leads to one', async () => {
    symlinkSync(join(root, 'project'), join(root, 'link'))
    expect(await codeOf(validateSessionCwd(join(root, 'project')))).toBe(
      'no error',
    )
    expect(await codeOf(validateSessionCwd(join(root, 'link')))).toBe(
      'no error',
    )
  })

  test('separates the reasons a path cannot be a working directory', async () => {
    expect(await codeOf(validateSessionCwd('project'))).toBe('cwd_not_absolute')
    expect(await codeOf(validateSessionCwd('//server/share'))).toBe(
      'cwd_not_local',
    )
    expect(await codeOf(validateSessionCwd(join(root, 'nowhere')))).toBe(
      'cwd_not_found',
    )
    expect(await codeOf(validateSessionCwd(join(root, 'file.txt')))).toBe(
      'cwd_not_directory',
    )
    expect(await codeOf(validateSessionCwd(join(root, 'file.txt', 'x')))).toBe(
      'cwd_not_directory',
    )
  })
})
