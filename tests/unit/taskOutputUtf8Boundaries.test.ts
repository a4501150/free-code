/**
 * Byte-range reads of live output files must never split a multi-byte UTF-8
 * sequence: the WebUI streams task output as deltas that resume at the
 * reported offset, and a window decoded mid-sequence corrupts the character
 * (emoji included) with U+FFFD forever. These tests cut a stream at every
 * byte offset, which is exactly what a poll boundary does to live output.
 */
import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileRange, tailFile } from '../../src/utils/fsOperations'

const SAMPLE =
  'hello 🎉 world ✅ 中文 ok é — line2 🚀\n' + 'x'.repeat(50) + ' 🧪'

async function makeFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskout-utf8-'))
  const path = join(dir, 'out.txt')
  await writeFile(path, content)
  return path
}

test('readFileRange never decodes a mid-sequence tail and defers its bytes', async () => {
  const path = await makeFile(SAMPLE)
  const total = Buffer.byteLength(SAMPLE)
  for (let cut = 1; cut < total; cut++) {
    const r = await readFileRange(path, 0, cut)
    expect(r!.content).not.toContain('�')
    // The reported offset stays on a character boundary and never advances
    // past what the returned content decoded.
    expect(Buffer.byteLength(r!.content)).toBeLessThanOrEqual(cut)
  }
})

test('sequential readFileRange deltas reassemble the stream byte-exact', async () => {
  const path = await makeFile(SAMPLE)
  const total = Buffer.byteLength(SAMPLE)
  let content = ''
  let offset = 0
  // Tiny windows: every multi-byte sequence is guaranteed to sit on some
  // window boundary at least once.
  for (let window = 1; offset < total; window = (window % 7) + 1) {
    const r = await readFileRange(path, offset, window)
    if (!r) break
    content += r.content
    offset += r.bytesRead
    expect(offset).toBeLessThanOrEqual(total)
  }
  expect(content).toBe(SAMPLE)
})

test('tailFile drops the leading partial sequence and reports an aligned offset', async () => {
  const path = await makeFile(SAMPLE)
  const total = Buffer.byteLength(SAMPLE)
  for (let maxBytes = 1; maxBytes < total; maxBytes++) {
    const r = await tailFile(path, maxBytes)
    expect(r.content).not.toContain('�')
    // The offset the WebUI subscribes from must sit on a character boundary:
    // re-reading from it yields a clean suffix of the stream.
    const offset = r.bytesTotal - r.bytesRead
    const suffix = await readFileRange(path, offset, Number.MAX_SAFE_INTEGER)
    expect(suffix?.content ?? '').toBe(r.content)
  }
})
