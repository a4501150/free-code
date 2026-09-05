import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileInRange } from '../../src/utils/readFileInRange.js'

describe('readFileInRange — anchor context lines', () => {
  test('returns up to 2 neighbor lines on each side of the slice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'readFileInRange-'))
    try {
      const file = join(dir, 'f.txt')
      const content = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join(
        '\n',
      )
      await writeFile(file, content)

      // Lines 3..5 (1-based).
      const mid = await readFileInRange(file, 2, 3)
      expect(mid.content).toBe('l3\nl4\nl5')
      expect(mid.prevLines).toEqual(['l1', 'l2'])
      expect(mid.nextLines).toEqual(['l6', 'l7'])

      const top = await readFileInRange(file, 0, 3)
      expect(top.prevLines).toBeUndefined()
      expect(top.nextLines).toEqual(['l4', 'l5'])

      const rest = await readFileInRange(file, 5)
      expect(rest.nextLines).toBeUndefined()

      // One line above exists only when one line above exists.
      const second = await readFileInRange(file, 1, 3)
      expect(second.prevLines).toEqual(['l1'])

      // Truncated output still reports the lines just past what it kept.
      const truncated = await readFileInRange(file, 0, undefined, 4, undefined, {
        truncateOnByteLimit: true,
      })
      expect(truncated.truncatedByBytes).toBe(true)
      expect(truncated.nextLines?.[0]).toBe(
        `l${truncated.lineCount + 1}`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
