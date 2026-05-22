/**
 * AskUserQuestion Alignment E2E Test
 *
 * Verifies that the "Other" text input option and footer options
 * ("Chat about this") are horizontally aligned with the Select
 * component's text options in the AskUserQuestion dialog.
 */

import {
  describe,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  test,
  setDefaultTimeout,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { toolUseResponse, textResponse } from '../helpers/fixture-builders'
import { TmuxSession, sleep } from './tmux-helpers'

setDefaultTimeout(120_000)

function getNumberColumn(line: string): number {
  const match = line.match(/(\d+)\./)
  if (!match) return -1
  return line.indexOf(match[0])
}

describe('AskUserQuestion Alignment', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  let session: TmuxSession

  afterEach(async () => {
    if (session) await session.stop()
  })

  test('footer items align with select options', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which approach should we use?',
                header: 'Approach',
                options: [
                  {
                    label: 'Option A',
                    description: 'First approach with some description text.',
                  },
                  {
                    label: 'Option B',
                    description: 'Second approach with some description text.',
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ]),
      textResponse('OK, got it.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 120,
      additionalEnv: {
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
      },
    })
    await session.start()

    await session.sendLine('Help me choose an approach')
    await sleep(500)

    const screen = await session.waitForText('Chat about this', 30_000)
    const lines = screen.split('\n')

    const option1Line = lines.find(l => l.includes('Option A'))
    const option2Line = lines.find(l => l.includes('Option B'))
    const chatLine = lines.find(l => l.includes('Chat about this'))

    expect(option1Line).toBeDefined()
    expect(option2Line).toBeDefined()
    expect(chatLine).toBeDefined()

    const opt1Col = getNumberColumn(option1Line!)
    const opt2Col = getNumberColumn(option2Line!)
    const chatCol = getNumberColumn(chatLine!)

    expect(opt1Col).toBeGreaterThanOrEqual(0)
    expect(opt1Col).toBe(opt2Col)
    expect(opt1Col).toBe(chatCol)

    await session.sendSpecialKey('Escape')
    await sleep(500)
  })

  test('Other text input option aligns with text options and footer', async () => {
    server.reset([
      toolUseResponse([
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which approach should we use for the refund flow?',
                header: 'Refund',
                options: [
                  {
                    label: 'Direct refund (Recommended)',
                    description:
                      'Merchant can refund any VALID ticket directly.',
                  },
                  {
                    label: 'Cancel first, then refund',
                    description:
                      'Keep current pattern: tickets must be CANCELLED before refund.',
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ]),
      textResponse('OK, understood.'),
    ])

    session = new TmuxSession({
      serverUrl: server.url,
      height: 40,
      width: 120,
      additionalEnv: {
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
      },
    })
    await session.start()

    await session.sendLine('How should refunds work?')
    await sleep(500)

    await session.waitForText('Chat about this', 30_000)

    // Navigate to the "Other" input option and type
    await session.sendSpecialKey('Down')
    await sleep(200)
    await session.sendSpecialKey('Down')
    await sleep(200)
    await session.sendText('I prefer a different approach')
    await sleep(500)

    const screen = await session.capturePane()
    const lines = screen.split('\n')

    const opt1Line = lines.find(l => l.includes('Direct refund'))
    const opt2Line = lines.find(l => l.includes('Cancel first'))
    const otherLine = lines.find(l => l.includes('I prefer a different'))
    const chatLine = lines.find(l => l.includes('Chat about this'))

    expect(opt1Line).toBeDefined()
    expect(opt2Line).toBeDefined()
    expect(otherLine).toBeDefined()
    expect(chatLine).toBeDefined()

    const col1 = getNumberColumn(opt1Line!)
    const col2 = getNumberColumn(opt2Line!)
    const colOther = getNumberColumn(otherLine!)
    const colChat = getNumberColumn(chatLine!)

    expect(col1).toBeGreaterThanOrEqual(0)
    expect(col1).toBe(col2)
    expect(col1).toBe(colOther)
    expect(col1).toBe(colChat)

    await session.sendSpecialKey('Escape')
    await sleep(500)
  })
})
