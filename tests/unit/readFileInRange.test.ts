import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeHashlineLabels } from '../../src/utils/hashline.js'
import { readFileInRange } from '../../src/utils/readFileInRange.js'

describe('readFileInRange — slices', () => {
  test('returns the requested line range', async () => {
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
      expect(mid.totalLines).toBe(10)

      const rest = await readFileInRange(file, 5)
      expect(rest.content).toBe('l6\nl7\nl8\nl9\nl10')

      // Truncate mode caps the output without throwing.
      const truncated = await readFileInRange(
        file,
        0,
        undefined,
        4,
        undefined,
        {
          truncateOnByteLimit: true,
        },
      )
      expect(truncated.truncatedByBytes).toBe(true)
      expect(truncated.lineCount).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('decodes UTF-16LE files by BOM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'readFileInRange-'))
    try {
      const file = join(dir, 'u16.txt')
      const text = 'alpha\nbeta\ngamma'
      const bom = Buffer.from([0xff, 0xfe])
      await writeFile(file, Buffer.concat([bom, Buffer.from(text, 'utf16le')]))

      const r = await readFileInRange(
        file,
        0,
        undefined,
        undefined,
        undefined,
        {
          includeHashlineLabels: true,
        },
      )
      expect(r.content).toBe(text)

      // Same labels the same content would get as UTF-8.
      const utf8File = join(dir, 'u8.txt')
      await writeFile(utf8File, text)
      const u8 = await readFileInRange(
        utf8File,
        0,
        undefined,
        undefined,
        undefined,
        {
          includeHashlineLabels: true,
        },
      )
      expect(r.hashline).toEqual(u8.hashline)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('readFileInRange — hashline labels', () => {
  test('fast path labels cover the whole file, not the slice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'readFileInRange-'))
    try {
      const file = join(dir, 'f.txt')
      const content = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join(
        '\n',
      )
      await writeFile(file, content)

      const whole = computeHashlineLabels(content)
      const slice = await readFileInRange(file, 10, 5, undefined, undefined, {
        includeHashlineLabels: true,
      })
      expect(slice.hashline?.length).toBe(whole.length)
      for (let i = 0; i < 5; i++) {
        expect(slice.hashline?.labels[10 + i]).toEqual(whole.labels[10 + i])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('streaming path second pass matches whole-file labels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'readFileInRange-'))
    try {
      const file = join(dir, 'big.txt')
      // ~11 MB so the fast path (10 MB cap) is not taken.
      const lines: string[] = []
      for (let i = 0; i < 350_000; i++) {
        lines.push(`l${i} ${'x'.repeat(10)}`)
        if (i % 7 === 0) lines.push('dup')
      }
      const content = lines.join('\n')
      await writeFile(file, content)

      const slice = await readFileInRange(file, 1000, 3, undefined, undefined, {
        includeHashlineLabels: true,
      })
      expect(slice.totalLines).toBe(lines.length)
      expect(slice.content).toBe(lines.slice(1000, 1003).join('\n'))
      expect(slice.hashline).toBeDefined()

      const whole = computeHashlineLabels(content)
      expect(slice.hashline?.length).toBe(whole.length)
      for (let i = 1000; i < 1003; i++) {
        expect(slice.hashline?.labels[i]).toEqual(whole.labels[i])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
