import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test as bunTest,
} from 'bun:test'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { MockAnthropicServer } from '../helpers/mock-server'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { waitFor } from '../helpers/wait-helpers'
import { createLoggingTest, sleep, TmuxSession } from './tmux-helpers'
import { readAttachDescriptor } from '../../src/webui/attach/attachDescriptor'
import { connectAttachClient } from '../../src/webui/gateway/attachClient'
import type { AttachEventBody } from '../../src/webui/protocol/attachSchemas'
import type { WebTranscriptItem } from '../../src/webui/protocol/transcriptWire'

setDefaultTimeout(180_000)
const test = createLoggingTest(bunTest)

/**
 * Waits until the CLI is attachable and returns its pid.
 *
 * The pid file lands before the attach descriptor does: the host starts after
 * session registration resolves, and writes its descriptor from the listen
 * callback. A gateway sees that window as "registered but not yet attachable",
 * so the test waits for the descriptor rather than the pid file.
 */
async function waitForAttachablePid(configDir: string): Promise<number> {
  // The attach paths derive from the config home, and the CLI runs with an
  // isolated one. Point this process at the same place before reading it.
  process.env.FREECODE_CONFIG_DIR = configDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  return waitFor(
    async () => {
      try {
        const files = await readdir(join(configDir, 'sessions'))
        const pidFile = files.find(f => /^\d+\.json$/.test(f))
        if (!pidFile) return 0
        const pid = parseInt(pidFile.slice(0, -5), 10)
        return readAttachDescriptor(pid).ok ? pid : 0
      } catch {
        return 0
      }
    },
    pid => pid > 0,
    { description: 'the CLI to become attachable', timeoutMs: 30_000 },
  )
}

/** Collects attach events, with helpers to await a particular one. */
function makeCollector() {
  const events: AttachEventBody[] = []
  return {
    events,
    handlers: {
      onEvent: (_seq: number, event: AttachEventBody) => {
        events.push(event)
      },
      onClose: () => {},
    },
    waitForEvent: <K extends AttachEventBody['kind']>(
      kind: K,
      predicate: (
        event: Extract<AttachEventBody, { kind: K }>,
      ) => boolean = () => true,
      description = `a ${kind} event`,
    ) =>
      waitFor(
        () =>
          events.filter(
            (e): e is Extract<AttachEventBody, { kind: K }> => e.kind === kind,
          ),
        matches => matches.some(predicate),
        { description, timeoutMs: 30_000 },
      ).then(matches => matches.filter(predicate).at(-1)!),
  }
}

/** Every transcript item the browser would hold, after applying all patches. */
function materialize(events: AttachEventBody[]): WebTranscriptItem[] {
  const byId = new Map<string, WebTranscriptItem>()
  let order: string[] = []

  for (const event of events) {
    if (event.kind === 'snapshot') {
      byId.clear()
      for (const item of event.transcript.items) byId.set(item.id, item)
      order = [...event.transcript.order]
    } else if (event.kind === 'transcript') {
      const patch = event.patch
      if (patch.type === 'replace') {
        byId.clear()
        for (const item of patch.snapshot.items) byId.set(item.id, item)
        order = [...patch.snapshot.order]
      } else {
        for (const id of patch.remove) byId.delete(id)
        for (const item of patch.upsert) byId.set(item.id, item)
        if (patch.order) order = [...patch.order]
        else if (patch.orderAppend) order = [...order, ...patch.orderAppend]
      }
    }
  }

  return order.map(id => byId.get(id)).filter(Boolean) as WebTranscriptItem[]
}

describe('WebUI attach', () => {
  let server: MockAnthropicServer
  let session: TmuxSession

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('mirrors a live terminal session transcript to an attached client', async () => {
    server.reset([textResponse('The answer is 42.')])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    const pid = await waitForAttachablePid(session.configDirPath!)
    const collector = makeCollector()
    const client = await connectAttachClient(pid, collector.handlers)

    try {
      const subscribed = await client.request({ kind: 'subscribe' })
      expect(subscribed.ok).toBe(true)
      await collector.waitForEvent('snapshot')

      await session.submitAndWaitForResponse('What is the answer?')
      await waitForRequestCount(server, 1, { description: 'the turn request' })

      await collector.waitForEvent(
        'transcript',
        () =>
          materialize(collector.events).some(
            item => item.kind === 'assistant' && item.text?.includes('42'),
          ),
        'the assistant reply to reach the attached client',
      )

      const items = materialize(collector.events)
      const user = items.find(
        item =>
          item.kind === 'user' && item.text?.includes('What is the answer'),
      )
      expect(user).toBeDefined()
      const assistant = items.find(
        item => item.kind === 'assistant' && item.text?.includes('42'),
      )
      expect(assistant).toBeDefined()
    } finally {
      client.close()
    }
  })

  test('injects a prompt from the client into the live session', async () => {
    server.reset([textResponse('Acknowledged from the browser.')])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    const pid = await waitForAttachablePid(session.configDirPath!)
    const collector = makeCollector()
    const client = await connectAttachClient(pid, collector.handlers)

    try {
      await client.request({ kind: 'subscribe' })
      const snapshot = await collector.waitForEvent('snapshot')

      const submitted = await client.request({
        kind: 'submit',
        commandId: crypto.randomUUID(),
        content: 'hello from the attached client',
        delivery: 'next',
        sessionEpoch: snapshot.meta.sessionEpoch,
      })
      expect(submitted.ok).toBe(true)

      // Assert on the wire, not the pane: the request log is authoritative.
      const log = await waitForRequestCount(server, 1, {
        description: 'the injected prompt reaching the API',
      })
      const messages = log[0]!.body.messages ?? []
      const serialized = JSON.stringify(messages)
      expect(serialized).toContain('hello from the attached client')
    } finally {
      client.close()
    }
  })

  test('rejects a prompt composed against a stale session epoch', async () => {
    server.reset([textResponse('ok')])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    const pid = await waitForAttachablePid(session.configDirPath!)
    const collector = makeCollector()
    const client = await connectAttachClient(pid, collector.handlers)

    try {
      await client.request({ kind: 'subscribe' })
      await collector.waitForEvent('snapshot')

      const stale = await client.request({
        kind: 'submit',
        commandId: crypto.randomUUID(),
        content: 'composed against a session that moved on',
        delivery: 'next',
        sessionEpoch: 99,
      })
      expect(stale.ok).toBe(false)
      expect(stale.error?.code).toBe('stale_epoch')
    } finally {
      client.close()
    }
  })

  test('surfaces a permission prompt and resolves it from the client', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'touch /tmp/webui_e2e_marker' } },
      ]),
      textResponse('Tool finished.'),
    ])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    const pid = await waitForAttachablePid(session.configDirPath!)
    const collector = makeCollector()
    const client = await connectAttachClient(pid, collector.handlers)

    try {
      await client.request({ kind: 'subscribe' })
      await collector.waitForEvent('snapshot')

      await session.sendLine('Run the touch command')

      const opened = await collector.waitForEvent(
        'permission_opened',
        event => event.request.toolName === 'Bash',
        'the Bash permission prompt to reach the attached client',
      )
      expect(opened.request.description.length).toBeGreaterThan(0)

      // The terminal dialog is open at the same time; the browser wins the race.
      const decided = await client.request({
        kind: 'permission_decision',
        requestId: opened.request.requestId,
        decision: { behavior: 'allow' },
      })
      expect(decided.ok).toBe(true)

      await collector.waitForEvent(
        'permission_closed',
        event => event.requestId === opened.request.requestId,
        'the permission to close',
      )

      // Two requests means the tool ran and its result went back to the model.
      await waitForRequestCount(server, 2, {
        description: 'the tool_result follow-up after browser approval',
      })

      // The terminal dialog must be gone, not still waiting for a keypress.
      await session.waitForPrompt()
      const screen = await session.capturePane()
      expect(screen).not.toContain('Do you want to proceed')
    } finally {
      client.close()
    }
  })

  test('leaves a pending permission open when the client disconnects', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'touch /tmp/webui_e2e_marker2' } },
      ]),
      textResponse('Tool finished.'),
    ])
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    const pid = await waitForAttachablePid(session.configDirPath!)
    const collector = makeCollector()
    const client = await connectAttachClient(pid, collector.handlers)

    await client.request({ kind: 'subscribe' })
    await collector.waitForEvent('snapshot')
    await session.sendLine('Run the touch command')
    await collector.waitForEvent(
      'permission_opened',
      event => event.request.toolName === 'Bash',
    )

    // Drop the browser mid-decision. A disconnect must not deny by omission.
    client.close()
    await sleep(500)

    // The terminal dialog is still live and still answerable.
    await session.waitForText('Do you want to proceed', 15_000)
    await session.sendSpecialKey('Enter')
    await waitForRequestCount(server, 2, {
      description: 'the tool_result follow-up after local approval',
    })
  })
})
