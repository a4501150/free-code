/**
 * WebUI bash-mode parity: a `!` command submitted from an attached client
 * executes locally under a PTY (not as model prompt text), registers as an
 * interactive task, streams its raw output via task_output, and accepts
 * input through the task_input frame — the full round trip the browser
 * terminal is built on. Asserted on the attach wire; the request log proves
 * the command never went to the model.
 */
import { describe, expect, setDefaultTimeout, test as bunTest } from 'bun:test'
import { waitFor } from '../helpers/wait-helpers'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'
import { connectAttachClient } from '../../src/webui/gateway/attachClient'
import { readAttachDescriptor } from '../../src/server/descriptor'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { AttachEventBody } from '../../src/webui/protocol/attachSchemas'

// Mirrors webui-attach.test.ts (kept local so importing this file does not
// re-run that suite).
async function waitForAttachablePid(configDir: string): Promise<number> {
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
      description = 'a ' + kind + ' event',
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

setDefaultTimeout(180_000)
const test = createLoggingTest(bunTest)

describe('WebUI interactive bash', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession

  test('`!` from the client runs locally, streams, and takes task_input', async () => {
    server.reset([])
    session = await startSession()

    const pid = await waitForAttachablePid(session.configDirPath!)
    const collector = makeCollector()
    const client = await connectAttachClient(pid, collector.handlers)

    try {
      const subscribed = await client.request({ kind: 'subscribe' })
      expect(subscribed.ok).toBe(true)
      const snapshot = await collector.waitForEvent('snapshot')

      const submitted = await client.request({
        kind: 'submit',
        commandId: crypto.randomUUID(),
        content:
          `! bash -c 'printf "\\033[32m🎉 ready\\033[0m\\n"; ` +
          `read -s -p "WebPass: " p; echo "got $p"'`,
        delivery: 'next',
        sessionEpoch: snapshot.meta.sessionEpoch,
      })
      expect(submitted.ok).toBe(true)

      // The run registers as an interactive local_bash task immediately —
      // the browser terminal needs its id before the first byte.
      const interactiveTask = await collector.waitForEvent(
        'tasks',
        event =>
          event.tasks.some(
            task =>
              task.taskType === 'local_bash' &&
              task.interactive === true &&
              task.status === 'running',
          ),
        'an interactive local_bash task to register',
      )
      const taskId = interactiveTask.tasks.find(
        task => task.taskType === 'local_bash' && task.interactive,
      )!.id

      // Replay + live stream from byte zero: the terminal emulator needs
      // the complete raw stream, not a text tail.
      const streaming = await client.request({
        kind: 'subscribe_task',
        taskId,
        fromOffset: 0,
      })
      expect(streaming.ok).toBe(true)

      // Invariant: byte-range deltas carry valid text only. A split
      // multi-byte sequence would surface as U+FFFD in the frame the
      // browser feeds to xterm and corrupt the character forever.
      await collector.waitForEvent(
        'task_output',
        event =>
          event.append.includes('🎉 ready') && !event.append.includes('\uFFFD'),
        'the colored emoji line to stream intact',
      )

      await collector.waitForEvent(
        'task_output',
        event => event.append.includes('WebPass:'),
        "the child's password prompt to stream",
      )

      // Input flows through the attach frame into the PTY; the typed
      // password is never persisted to any transcript.
      const typed = await client.request({
        kind: 'task_input',
        taskId,
        data: 'hunter3\r',
      })
      expect(typed.ok).toBe(true)

      await collector.waitForEvent(
        'task_output',
        event => event.append.includes('got hunter3'),
        'the echo of the typed password to stream',
      )

      // Local execution, end to end: the bash command never reached the
      // model — the whole flow rode the attach wire.
      expect(server.getRequestLog().length).toBe(0)
    } finally {
      client.close()
    }
  })
})
