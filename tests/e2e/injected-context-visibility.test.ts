/**
 * Injected-context visibility E2E.
 *
 * `showInjectedContext` (default true) surfaces model-facing context the user
 * never used to see. Two things are worth an E2E:
 *
 * 1. The rows are collapsed and expand on a real mouse click. Click-to-expand
 *    only exists in the alternate screen (src/ink/ink.tsx:1455), so this can't
 *    be covered by a unit render.
 * 2. Turning the setting on must not change a single byte of the request. The
 *    user-context block stays request-only (prependUserContext) precisely
 *    because the attribution fingerprint is derived from the first API user
 *    message; the transcript row is rebuilt for display instead.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import {
  TmuxSession,
  sleep,
  createLoggingTest,
  findTextCell,
} from './tmux-helpers'

setDefaultTimeout(180_000)

const test = createLoggingTest(bunTest)

/** One background bash that completes, then the drained notification turn. */
function backgroundBashResponses() {
  return [
    toolUseResponse([
      {
        name: 'Bash',
        input: {
          command: 'echo hello',
          description: 'greeter',
          run_in_background: true,
        },
      },
    ]),
    textResponse('Started in background.'),
    textResponse('Acknowledged.'),
  ]
}

const BACKGROUND_TASK_ENV = {
  // The default test env sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, which
  // strips run_in_background from the Bash schema.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
}

describe('Injected context visibility', () => {
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

  test('task notification is collapsed and expands to full detail on click', async () => {
    server.reset(backgroundBashResponses())

    session = new TmuxSession({
      serverUrl: server.url,
      additionalEnv: BACKGROUND_TASK_ENV,
      settings: { permissions: { allow: ['Bash'] } },
    })
    await session.start()

    await session.submitAndApprove('Run a quick task in the background')
    await session.waitForText('Acknowledged.', 20_000)

    // The summary line is the collapsed form — unchanged from before the
    // feature, so the default transcript looks the same.
    const collapsed = await session.waitForScreen(
      s => s.includes('Background command "greeter" completed'),
      {
        timeoutMs: 15_000,
        intervalMs: 250,
        description: 'collapsed background task notification row',
        currentPaneOnly: true,
      },
    )
    expect(collapsed).not.toContain('<task-id>')

    const cell = findTextCell(
      collapsed,
      'Background command "greeter" completed',
    )
    expect(cell).not.toBeNull()
    await session.sendMouseClick(cell!.col, cell!.row)

    // Expanding reveals the notification's own fields, which previously never
    // reached the UI at all.
    await session.waitForScreen(s => s.includes('<task-id>'), {
      timeoutMs: 10_000,
      intervalMs: 250,
      description: 'expanded task notification detail',
      currentPaneOnly: true,
    })
  })

  test('the request-only user context is its own labelled row', async () => {
    server.reset([textResponse('Hi.')])

    const cwd = mkdtempSync(join(tmpdir(), 'injected-context-cwd-'))
    writeFileSync(
      join(cwd, 'CLAUDE.md'),
      '# Project rules\nDISTINCTIVE_CLAUDE_MD_MARKER\n',
    )

    session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      additionalEnv: {
        // prependUserContext returns early under NODE_ENV=test, and the
        // harness disables CLAUDE.md by default; the row exists to show what
        // those would send, so both have to be on for this test.
        NODE_ENV: 'development',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
      },
    })
    await session.start()

    // Labelled apart from ordinary reminders: it is the session's own context,
    // not a mid-conversation nudge, and it opens the transcript.
    const pane = await session.waitForScreen(
      s => s.includes('Session context'),
      {
        timeoutMs: 20_000,
        intervalMs: 250,
        description: 'collapsed session-context row',
        currentPaneOnly: true,
      },
    )
    expect(pane).not.toContain('DISTINCTIVE_CLAUDE_MD_MARKER')

    const cell = findTextCell(pane, 'Session context')
    expect(cell).not.toBeNull()
    await session.sendMouseClick(cell!.col, cell!.row)

    await session.waitForScreen(
      s => s.includes('DISTINCTIVE_CLAUDE_MD_MARKER'),
      {
        timeoutMs: 10_000,
        intervalMs: 250,
        description: 'expanded session-context body',
        currentPaneOnly: true,
      },
    )
  })

  test('with the setting off the row stays summary-only', async () => {
    server.reset(backgroundBashResponses())

    session = new TmuxSession({
      serverUrl: server.url,
      additionalEnv: BACKGROUND_TASK_ENV,
      settings: {
        permissions: { allow: ['Bash'] },
        showInjectedContext: false,
      },
    })
    await session.start()

    await session.submitAndApprove('Run a quick task in the background')
    await session.waitForText('Acknowledged.', 20_000)

    const pane = await session.waitForScreen(
      s => s.includes('Background command "greeter" completed'),
      {
        timeoutMs: 15_000,
        intervalMs: 250,
        description: 'background task notification row',
        currentPaneOnly: true,
      },
    )

    const cell = findTextCell(pane, 'Background command "greeter" completed')
    expect(cell).not.toBeNull()
    await session.sendMouseClick(cell!.col, cell!.row)
    await sleep(1500)

    // Not clickable with the setting off, so no detail appears.
    const after = await session.capturePane()
    expect(after).not.toContain('<task-id>')
  })

  test('toggling the setting does not change the request body', async () => {
    async function wireMessages(showInjectedContext: boolean): Promise<string> {
      server.reset([textResponse('Done.')])
      const s = new TmuxSession({
        serverUrl: server.url,
        settings: { showInjectedContext },
      })
      try {
        await s.start()
        await s.sendLine('hello there')
        // Wait on the request itself, not the prompt: waitForPrompt matches
        // the already-idle prompt if the CLI hasn't consumed the input yet,
        // which it hasn't under full-suite load.
        const log = await waitForRequestCount(server, 1, {
          timeoutMs: 30_000,
          description: 'the turn request for the wire comparison',
        })
        const serialized = JSON.stringify(log[0]!.body.messages)
        // Each session gets its own mkdtemp config dir and cwd, and both paths
        // appear inside the skills/keybindings reminder. The scratchpad path in
        // the user context additionally carries a per-session UUID. Normalize
        // that per-session noise so the comparison is about the setting only.
        return serialized
          .split(s.configDirPath ?? '\u0000')
          .join('<CONFIG_DIR>')
          .split(s.cwd)
          .join('<CWD>')
          .replace(/`[^`]*\/scratchpad`/g, '`<SCRATCHPAD>`')
      } finally {
        await s.stop()
      }
    }

    const withOn = await wireMessages(true)
    const withOff = await wireMessages(false)

    // Byte-for-byte identical wire history: the display-only row must never
    // reach the API, or the cached prefix and the attribution fingerprint over
    // the first user message would both shift.
    expect(withOn).toBe(withOff)
  })
})
