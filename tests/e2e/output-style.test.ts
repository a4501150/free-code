/**
 * Output style E2E
 *
 * The style reaches the API request as a `# Output Style:` system prompt
 * section, and picking one in /output-style writes the setting without
 * disturbing the session already running.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test as bunTest,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(120_000)
import { readFile } from 'fs/promises'
import { join } from 'path'
import { textResponse } from '../helpers/fixture-builders'
import { MockAnthropicServer } from '../helpers/mock-server'
import { createLoggingTest, TmuxSession } from './tmux-helpers'

const test = createLoggingTest(bunTest)

function systemText(server: MockAnthropicServer): string {
  const request = server.getRequestLog()[0]
  return JSON.stringify(request?.body.system ?? '')
}

describe('Output styles', () => {
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

  test('defaults to simple-english and keeps every prompt section', async () => {
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    server.reset([textResponse('Done.')])
    await session.sendLine('Say hello')
    await session.waitForText('Done.', 15_000)

    const system = systemText(server)
    expect(system).toContain('# Output Style: simple-english')
    expect(system).toContain('# Doing tasks')
    expect(system).toContain('# Code style')
    expect(system).toContain('# Response style')
  })

  test('outputStyle none removes the section and keeps the rest', async () => {
    session = new TmuxSession({
      serverUrl: server.url,
      settings: { outputStyle: 'none' },
    })
    await session.start()

    server.reset([textResponse('Done.')])
    await session.sendLine('Say hello')
    await session.waitForText('Done.', 15_000)

    const system = systemText(server)
    expect(system).not.toContain('# Output Style')
    expect(system).toContain('# Doing tasks')
    expect(system).toContain('# Response style')
  })

  test('/output-style picks a style and defers it to the next session', async () => {
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    server.reset([])
    await session.sendLine('/output-style')
    let screen = await session.waitForText('simple-english', 15_000)
    expect(screen).toContain('Output style')
    expect(screen).toContain('none')
    expect(screen).toContain('next session')

    // 'none' is the first option; the current style is focused, so go up.
    await session.sendKeys('Up')
    await session.sendKeys('Enter')
    screen = await session.waitForText('Set output style', 15_000)
    expect(screen).toContain('none')
    expect(screen).toContain('next session')

    const configDir = session.configDirPath
    expect(configDir).not.toBeNull()
    const settings = JSON.parse(
      await readFile(join(configDir as string, 'freecode.json'), 'utf-8'),
    )
    expect(settings.outputStyle).toBe('none')
  })

  test('/config lists the output style row', async () => {
    session = new TmuxSession({ serverUrl: server.url })
    await session.start()

    server.reset([])
    await session.sendLine('/config')
    await session.waitForText('Type to filter', 15_000)
    await session.sendText('output')
    const screen = await session.waitForText('Output style', 15_000)
    expect(screen).toContain('simple-english (default)')
  })
})
