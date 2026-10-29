/**
 * Bash redirect dual-write E2E
 *
 * The output-capture rewrite turns `cmd > file` into `cmd | tee file`: the
 * target must genuinely receive the write (an old harness bug rewrote the
 * target to the capture file instead — a `cat >> file <<'EOF'` append never
 * landed and a green test run hid it), while the tee passthrough keeps the
 * full stream in the capture file the footer names. Verified end-to-end via
 * the request log's tool_result and the on-disk files.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type RequestLogEntry } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

const test = createLoggingTest(bunTest)

function getToolResultString(log: RequestLogEntry[], requestIndex = 1): string {
  const messages = log[requestIndex]!.body.messages as Array<{
    role: string
    content: Array<{
      type: string
      tool_use_id?: string
      content?: unknown
    }>
  }>
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return ''
  const block = lastUserMsg.content.find(c => c.type === 'tool_result')
  const content = block?.content
  if (typeof content === 'string') return content
  return JSON.stringify(content ?? '')
}

describe('Bash redirect dual-write', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession

  test('a > redirect writes the target file and keeps the stream captured', async () => {
    session = await startSession()
    const target = join(session.cwd, 'dual-write-out.txt')

    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: `echo marker > ${target}` } },
      ]),
      textResponse('Done'),
    ])
    await session.submitAndApprove('Write the marker file')
    const log = await waitForRequestCount(server, 2, {
      description: 'dual-write tool_result request',
    })

    // The incident regression: the write must genuinely land.
    const onDisk = await readFile(target, 'utf-8')
    expect(onDisk).toBe('marker\n')

    // The model is told the target was written and where the full stream is.
    const result = getToolResultString(log)
    expect(result).toContain(
      `[redirect dual-write: ${target} written as requested; the full stream is also captured below]`,
    )
    expect(result).toContain('[exit 0 · full output: ')
    // tee's passthrough is the inline stdout, same bytes the file received.
    expect(result).toContain('marker')
  })

  test('a heredoc append lands in the target file (the false-green shape)', async () => {
    session = await startSession()
    const target = join(session.cwd, 'heredoc-append.txt')
    await writeFile(target, 'original line\n')

    server.reset([
      toolUseResponse([
        {
          name: 'Bash',
          input: {
            command: `cat >> ${target} <<'EOF'\nappended line one\nappended line two\nEOF`,
          },
        },
      ]),
      textResponse('Done'),
    ])
    await session.submitAndApprove('Append via heredoc')
    const log = await waitForRequestCount(server, 2, {
      description: 'heredoc append tool_result request',
    })

    const onDisk = await readFile(target, 'utf-8')
    expect(onDisk).toBe('original line\nappended line one\nappended line two\n')

    const result = getToolResultString(log)
    expect(result).toContain(
      `[redirect dual-write: ${target} written as requested; the full stream is also captured below]`,
    )
  })

  test('a stripped trailing tail delivers the requested lines, not the head', async () => {
    session = await startSession()

    server.reset([
      toolUseResponse([
        {
          name: 'Bash',
          input: {
            command:
              "for i in $(seq 1 100); do printf 'row %03d\\n' $i; done | tail -3",
          },
        },
      ]),
      textResponse('Done'),
    ])
    await session.submitAndApprove('Print rows and tail them')
    const log = await waitForRequestCount(server, 2, {
      description: 'tail window tool_result request',
    })
    const result = getToolResultString(log)

    // The model receives exactly the lines it asked for: the tail window,
    // not the head of the stream.
    expect(result).toContain('row 098')
    expect(result).toContain('row 099')
    expect(result).toContain('row 100')
    expect(result).not.toContain('row 001')
    expect(result).toContain(
      '[trailing tail/head applied to your inline result; the complete stream is in the file below]',
    )

    // The complete stream — all 100 rows — stays in the footer path file.
    const pathMatch = /\[exit 0 · full output: ([^\]]+)\]/.exec(result)
    expect(pathMatch).not.toBeNull()
    const full = await readFile(pathMatch![1], 'utf-8')
    expect((full.match(/row \d+/g) ?? []).length).toBe(100)
  })
})
