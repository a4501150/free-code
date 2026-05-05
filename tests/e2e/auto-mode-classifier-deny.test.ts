/**
 * Auto Mode Classifier Deny E2E
 *
 * Reproduces and inspects the case where the auto-mode YOLO classifier blocks
 * a Bash tool_use. We feed the mock server a Bash tool_use, then mock both
 * stages of the 2-stage XML classifier to return <block>yes</block>, and
 * capture what the UI renders.
 *
 * Runs against ./cli-dev because TRANSCRIPT_CLASSIFIER (and thus the entire
 * auto-mode permission path + classifier UI) is in `fullExperimentalFeatures`
 * and stripped from the standard ./cli build at compile time.
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
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { MockAnthropicServer } from '../helpers/mock-server'
import { toolUseResponse, textResponse } from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

setDefaultTimeout(120_000)

const test = createLoggingTest(bunTest)

const PROJECT_ROOT = join(import.meta.dir, '..', '..')
const CLI_DEV_BINARY = join(PROJECT_ROOT, 'cli-dev')

/**
 * Build a raw SSE response with a single text block. Used to mock the XML
 * classifier stages — they expect the assistant to emit `<block>yes/no</block>`
 * (and optionally `<reason>...</reason>`) as plain text content.
 */
function classifierTextResponse(text: string) {
  return textResponse(text)
}

describe('Auto Mode Classifier Deny E2E', () => {
  let server: MockAnthropicServer
  let session: TmuxSession

  beforeAll(async () => {
    if (!existsSync(CLI_DEV_BINARY)) {
      throw new Error(
        `cli-dev binary not found at ${CLI_DEV_BINARY}. Run 'bun run build:dev:full' first.`,
      )
    }
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('collapsed view shows the count summary; the pill stays hidden until expand', async () => {
    server.reset([
      // 1. Main loop: assistant calls Bash with a destructive-looking command
      toolUseResponse([
        { name: 'Bash', input: { command: 'rm -rf /tmp/anything-special' } },
      ]),
      // 2. Stage 1 (fast) classifier: <block>yes</block> → escalate to stage 2
      classifierTextResponse('<block>yes</block>'),
      // 3. Stage 2 (thinking) classifier: final block decision with reason
      classifierTextResponse(
        '<block>yes</block><reason>Irreversible destruction blocked for test</reason>',
      ),
      // 4. Main loop continuation after the deny tool_result
      textResponse('Acknowledged.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      cliBinary: CLI_DEV_BINARY,
      width: 140,
      height: 50,
      // Auto mode replaces the standard "? for shortcuts" footer with the
      // mode-name banner ("⏵⏵ auto mode on …"), so the default readyText
      // never matches.
      readyText: 'shift+tab to cycle',
      // Mark this session as auto mode. defaultMode='auto' is only valid when
      // TRANSCRIPT_CLASSIFIER is compiled in (cli-dev). skipAutoPermissionPrompt
      // suppresses the first-time opt-in dialog so the test can reach the
      // classifier path immediately.
      settings: {
        autoMode: { enabled: true },
        permissions: {
          defaultMode: 'auto',
        },
        skipAutoPermissionPrompt: true,
      },
      // --enable-auto-mode is the explicit opt-in flag matching the CLI option.
      additionalArgs: ['--enable-auto-mode'],
    })
    await session.start()

    await session.sendLine('please run rm -rf /tmp/anything-special')

    // Wait for the mock to receive all 4 expected requests:
    //   1. main loop (Bash tool_use)
    //   2. classifier stage 1 (fast)
    //   3. classifier stage 2 (thinking)
    //   4. main loop continuation after the deny tool_result
    // The auto-mode banner "shift+tab to cycle" is always on screen so
    // waitForPrompt returns immediately and isn't a useful idle signal.
    await waitForRequestCount(server, 4, {
      timeoutMs: 60_000,
      description: 'auto-mode classifier collapsed-view requests',
    })
    const screen = await session.waitForText('Acknowledged.', 10_000)

    // Collapsed view (default): the bash got folded into "Ran 1 bash command"
    // and the deny detail is hidden — but the user can press ctrl+o (or use
    // --verbose) to expand and see it. The verbose-mode test below covers the
    // expanded path.
    const hasCount = screen.includes('Ran 1 bash command')
    const hasPill = screen.includes('Denied by auto mode classifier')

    expect(hasCount).toBe(true)
    // Pill is intentionally hidden in the collapsed view (it shows on expand).
    expect(hasPill).toBe(false)
  })

  test('verbose mode renders the classifier-denied bash result inline', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'rm -rf /tmp/anything-special' } },
      ]),
      classifierTextResponse('<block>yes</block>'),
      classifierTextResponse(
        '<block>yes</block><reason>Irreversible destruction blocked for test</reason>',
      ),
      textResponse('Acknowledged.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      cliBinary: CLI_DEV_BINARY,
      width: 140,
      height: 50,
      readyText: 'shift+tab to cycle',
      settings: {
        autoMode: { enabled: true },
        permissions: { defaultMode: 'auto' },
        skipAutoPermissionPrompt: true,
        verbose: true,
      },
      additionalArgs: ['--enable-auto-mode', '--verbose'],
    })
    await session.start()

    await session.sendLine('please run rm -rf /tmp/anything-special')

    await waitForRequestCount(server, 4, {
      timeoutMs: 60_000,
      description: 'auto-mode classifier verbose-view requests',
    })
    const screen = await session.waitForText('Acknowledged.', 10_000)

    const hasPill = screen.includes('Denied by auto mode classifier')

    // The pill should appear in verbose mode too. If this fails alongside
    // the non-verbose test, the bug is upstream of CollapsedReadSearchContent
    // (likely VerboseToolUse skipping isError results — see
    // CollapsedReadSearchContent.tsx:112: `isResolved && !isError && …`).
    expect(hasPill).toBe(true)
  })
})
