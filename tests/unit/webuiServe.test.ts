/**
 * The sessiond serve server: the browser contract (cookie login, CSRF,
 * session CRUD, SSE snapshot) against a hosted session in the same process.
 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeAuthFile } from '../../src/webui/gateway/auth.js'

// Every boot gets its own config home and HOME: the tests run in order in
// one process, and a cleanup that restored the process env would blind the
// next boot. bootServe swaps env in, cleanup swaps it back out.
const { startSessiondServe } = await import('../../src/sessiond/serve.js')
const { listSessionsImpl } = await import('../../src/utils/listSessionsImpl.js')

const PASSWORD = 'test-password-long-enough'

type Serve = Awaited<ReturnType<typeof startSessiondServe>>

async function bootServe(): Promise<{
  serve: Serve
  base: string
  cookie: string
  csrf: string
}> {
  const configHome = mkdtempSync(join(tmpdir(), 'webui-serve-config-'))
  const sessionsHome = mkdtempSync(join(tmpdir(), 'webui-serve-home-'))
  booted.push({ configHome, sessionsHome, env: { ...process.env } })
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.FREECODE_CONFIG_DIR = configHome
  process.env.HOME = sessionsHome
  process.env.USERPROFILE = sessionsHome
  await writeAuthFile(PASSWORD)
  const serve = await startSessiondServe({})
  const login = await fetch(`${serve.url}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: serve.url,
    },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(login.status).toBe(200)
  const body = (await login.json()) as { csrf: string }
  const setCookie = login.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]!
  return { serve, base: serve.url, cookie, csrf: body.csrf }
}

const booted: {
  configHome: string
  sessionsHome: string
  env: Record<string, string | undefined>
}[] = []

function restoreEnv(key: string, value: string | undefined): void {
  // Assigning undefined would string it to "undefined", which the
  // config-home resolver reads as a real override.
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function cleanup(serve: Serve): Promise<void> {
  await serve.stop()
  const boot = booted.pop()
  if (!boot) return
  restoreEnv('ANTHROPIC_API_KEY', boot.env.ANTHROPIC_API_KEY)
  restoreEnv('FREECODE_CONFIG_DIR', boot.env.FREECODE_CONFIG_DIR)
  restoreEnv('HOME', boot.env.HOME)
  restoreEnv('USERPROFILE', boot.env.USERPROFILE)
  rmSync(boot.configHome, { recursive: true, force: true })
  rmSync(boot.sessionsHome, { recursive: true, force: true })
}

test('serve: login gates the API and session routes', async () => {
  const { serve, base } = await bootServe()
  try {
    const unauth = await fetch(`${base}/api/sessions`)
    expect(unauth.status).toBe(401)

    const me = await fetch(`${base}/api/me`)
    expect(me.status).toBe(401)
  } finally {
    await cleanup(serve)
  }
})

test('serve: wrong csrf refuses commands, good csrf works', async () => {
  const { serve, base, cookie, csrf } = await bootServe()
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'webui-serve-cwd-'))
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie,
        'x-freecode-csrf': csrf,
      },
      body: JSON.stringify({ cwd }),
    })
    expect(created.status).toBe(200)
    const { session } = (await created.json()) as {
      session: { processKey: string; sessionId: string }
    }

    const bad = await fetch(
      `${base}/api/sessions/${session.processKey}/prompt`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          cookie,
          'x-freecode-csrf': 'wrong',
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: randomUUID(),
          content: 'hi',
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(bad.status).toBe(403)
    expect(((await bad.json()) as { error: string }).error).toBe('bad_csrf')

    rmSync(cwd, { recursive: true, force: true })
  } finally {
    await cleanup(serve)
  }
})

test('serve: create, stream snapshot, prompt lands on the hosted core, delete', async () => {
  const { serve, base, cookie, csrf } = await bootServe()
  const cwd = mkdtempSync(join(tmpdir(), 'webui-serve-run-'))
  try {
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie,
        'x-freecode-csrf': csrf,
      },
      body: JSON.stringify({ cwd }),
    })
    expect(created.status).toBe(200)
    const { session } = (await created.json()) as {
      session: { processKey: string; sessionId: string; cwd: string }
    }
    expect(session.processKey).toContain(':')
    // The serve realpathes the cwd the way a spawned child's process.cwd()
    // would have (/var vs /private/var on macOS).
    expect(session.cwd).toBe(realpathSync(cwd))

    // The list shows the hosted row as live and attachable, owned here.
    const list = await fetch(`${base}/api/sessions`, { headers: { cookie } })
    const { sessions } = (await list.json()) as {
      sessions: Array<{ sessionId: string; live: boolean; owned: boolean }>
    }
    const row = sessions.find(s => s.sessionId === session.sessionId)
    expect(row?.live).toBe(true)
    expect(row?.owned).toBe(true)

    // The SSE stream opens with a snapshot naming this session. Frames
    // coalesce into arbitrary reads, so the reader keeps one buffer and a
    // flat envelope list.
    const stream = await fetch(
      `${base}/api/sessions/${session.processKey}/events`,
      { headers: { cookie } },
    )
    expect(stream.status).toBe(200)
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader()
    const envelopes: Array<{
      seq: number
      event: {
        kind: string
        meta?: { sessionId: string }
        patch?: { upsert?: unknown[]; snapshot?: { items: unknown[] } }
      }
    }> = []
    let buffer = ''
    async function pumpFrames(done: () => boolean, ms = 3000): Promise<void> {
      const deadline = Date.now() + ms
      while (!done() && Date.now() < deadline) {
        const { done: ended, value } = await reader.read()
        if (ended) break
        buffer += value
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
          if (dataLine) envelopes.push(JSON.parse(dataLine.slice(6)))
        }
      }
    }
    const sawSnapshot = () => envelopes.some(e => e.event.kind === 'snapshot')
    await pumpFrames(sawSnapshot)
    expect(sawSnapshot()).toBe(true)
    const snapshot = envelopes.find(e => e.event.kind === 'snapshot')!
    expect(snapshot.event.meta?.sessionId).toBe(session.sessionId)

    // A prompt rides the command route onto the hosted core's transcript.
    const prompt = await fetch(
      `${base}/api/sessions/${session.processKey}/prompt`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          cookie,
          'x-freecode-csrf': csrf,
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: randomUUID(),
          content: `/nonexistent-${randomUUID()}`,
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(prompt.status).toBe(200)

    const entry = serve.registry.get(session.processKey)!
    const deadline = Date.now() + 3000
    while (
      entry.hosted.core.getMessages().length === 0 &&
      Date.now() < deadline
    ) {
      await Bun.sleep(50)
    }
    expect(entry.hosted.core.getMessages().length).toBeGreaterThan(0)
    // No other row is live: the prompt could only have landed here.
    for (const other of (await serve.registry.list()).filter(
      r => r.sessionId !== session.sessionId,
    )) {
      expect(other.live).toBe(false)
    }

    // The prompt arrived on the stream too: a transcript patch carrying
    // items, whenever it was coalesced into the socket.
    const sawPatchFrame = () =>
      envelopes.some(e => {
        if (e.event.kind !== 'transcript') return false
        const patch = e.event.patch
        if (!patch) return false
        const items = patch.snapshot?.items ?? patch.upsert ?? []
        return items.length > 0
      })
    await pumpFrames(sawPatchFrame)
    expect(sawPatchFrame()).toBe(true)
    await reader.cancel()

    // DELETE stops it: the row drops out of the live set.
    const deleted = await fetch(`${base}/api/sessions/${session.processKey}`, {
      method: 'DELETE',
      headers: { origin: base, cookie, 'x-freecode-csrf': csrf },
    })
    expect(deleted.status).toBe(200)
    const after = await fetch(`${base}/api/sessions`, {
      headers: { cookie },
    })
    const afterRows = (
      (await after.json()) as {
        sessions: Array<{ sessionId: string; live: boolean }>
      }
    ).sessions
    expect(
      afterRows.find(r => r.sessionId === session.sessionId)?.live,
    ).not.toBe(true)
  } finally {
    await cleanup(serve)
    rmSync(cwd, { recursive: true, force: true })
  }
}, 30_000)

test('serve: resume refuses unknown ids', async () => {
  const { serve, base, cookie, csrf } = await bootServe()
  try {
    const unknown = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie,
        'x-freecode-csrf': csrf,
      },
      body: JSON.stringify({ resumeSessionId: randomUUID() }),
    })
    expect(unknown.status).toBe(404)

    // The listing never throws on an empty history home.
    expect(
      (await listSessionsImpl({ limit: 5 })).length,
    ).toBeGreaterThanOrEqual(0)
  } finally {
    await cleanup(serve)
  }
})

test('serve: ?q filters the history only; live rows always show', async () => {
  const { serve, base, cookie, csrf } = await bootServe()
  const liveCwd = mkdtempSync(join(tmpdir(), 'webui-serve-q-live-'))
  // The fixture cwd carries the word the search will look for.
  const fixtureCwd = realpathSync(mkdtempSync(join(tmpdir(), 'webui-qsearch-')))
  try {
    // Two history rows written straight into the projects dir: transcript
    // persistence is off under NODE_ENV=test, and the registry rescans
    // this directory on every list.
    const fixtureDir = join(
      process.env.FREECODE_CONFIG_DIR!,
      'projects',
      'serve-q',
    )
    mkdirSync(fixtureDir, { recursive: true })
    const hitId = randomUUID()
    const missId = randomUUID()
    const fixtureLine = (id: string, cwd: string, prompt: string) =>
      JSON.stringify({
        type: 'user',
        sessionId: id,
        uuid: randomUUID(),
        timestamp: new Date(0).toISOString(),
        cwd,
        message: { role: 'user', content: prompt },
      }) + '\n'
    writeFileSync(
      join(fixtureDir, `${hitId}.jsonl`),
      fixtureLine(hitId, fixtureCwd, 'investigate qsearch flakiness'),
    )
    writeFileSync(
      join(fixtureDir, `${missId}.jsonl`),
      fixtureLine(missId, '/no/such/other/project', 'refactor the parser'),
    )

    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie,
        'x-freecode-csrf': csrf,
      },
      body: JSON.stringify({ cwd: liveCwd }),
    })
    expect(created.status).toBe(200)
    const { session } = (await created.json()) as {
      session: { processKey: string; sessionId: string }
    }

    const rowsFor = async (url: string) =>
      (
        (await (await fetch(url, { headers: { cookie } })).json()) as {
          sessions: Array<{ sessionId: string; live: boolean }>
        }
      ).sessions

    // A search hits the history by cwd substring...
    const hit = await rowsFor(`${base}/api/sessions?q=qsearch`)
    expect(hit.some(r => r.sessionId === hitId)).toBe(true)
    expect(hit.some(r => r.sessionId === missId)).toBe(false)
    // ...and the live set survives any query: the row the user is
    // watching must never be one keystroke away from disappearing.
    expect(hit.find(r => r.sessionId === session.sessionId)?.live).toBe(true)

    // The response shape is the plain listing's, searched or not.
    const plain = await rowsFor(`${base}/api/sessions`)
    const plainLive = plain.find(r => r.sessionId === session.sessionId)!
    const searchedLive = hit.find(r => r.sessionId === session.sessionId)!
    expect(Object.keys(searchedLive).sort()).toEqual(
      Object.keys(plainLive).sort(),
    )
    // Both history rows are there unfiltered.
    expect(plain.some(r => r.sessionId === hitId)).toBe(true)
    expect(plain.some(r => r.sessionId === missId)).toBe(true)

    // A query that matches nothing leaves only the live row.
    const miss = await rowsFor(`${base}/api/sessions?q=zzzznomatch`)
    expect(miss.find(r => r.sessionId === session.sessionId)?.live).toBe(true)
    expect(miss.some(r => r.sessionId === hitId)).toBe(false)
    expect(miss.some(r => r.sessionId === missId)).toBe(false)
  } finally {
    await cleanup(serve)
    rmSync(liveCwd, { recursive: true, force: true })
    rmSync(fixtureCwd, { recursive: true, force: true })
  }
}, 30_000)
