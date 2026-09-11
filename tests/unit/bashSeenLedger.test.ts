import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyBashReadCommand,
  recordBashReadSighting,
  recordGrepContentSightings,
} from '../../src/utils/fileSightings.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../../src/utils/fileStateCache.js'

function newCache(): FileStateCache {
  return createFileStateCacheWithSizeLimit(50, 1024 * 1024)
}

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sightings-'))
  const file = join(dir, name)
  await writeFile(file, content)
  return file
}

describe('classifyBashReadCommand', () => {
  test('cat and nl of one file read everything', () => {
    expect(classifyBashReadCommand(['cat', '/x/f.ts'], '/x')).toMatchObject({
      path: '/x/f.ts',
      kind: 'contiguous-from',
    })
    expect(classifyBashReadCommand(['nl', '/x/f.ts'], '/x')).toMatchObject({
      kind: 'contiguous-from',
    })
  })

  test('cat with flags or several files fails closed', () => {
    expect(classifyBashReadCommand(['cat', '-n', '/x/f.ts'], '/x')).toBe(null)
    expect(classifyBashReadCommand(['cat', 'a', 'b'], '/x')).toBe(null)
  })

  test('head line counts', () => {
    expect(classifyBashReadCommand(['head', '/x/f.ts'], '/x')).toMatchObject({
      expectedLineNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    })
    expect(
      classifyBashReadCommand(['head', '-n', '3', '/x/f.ts'], '/x'),
    ).toMatchObject({ expectedLineNos: [1, 2, 3] })
    expect(
      classifyBashReadCommand(['head', '-5', '/x/f.ts'], '/x'),
    ).toMatchObject({ expectedLineNos: [1, 2, 3, 4, 5] })
    expect(
      classifyBashReadCommand(['head', '-n3', '/x/f.ts'], '/x'),
    ).toMatchObject({ expectedLineNos: [1, 2, 3] })
  })

  test('sed -n ranges', () => {
    expect(
      classifyBashReadCommand(['sed', '-n', '4,6p', '/x/f.ts'], '/x'),
    ).toMatchObject({ expectedLineNos: [4, 5, 6] })
    expect(
      classifyBashReadCommand(['sed', '-n', '7p', '/x/f.ts'], '/x'),
    ).toMatchObject({ expectedLineNos: [7] })
    // Anything fancier than a plain range fails closed.
    expect(
      classifyBashReadCommand(['sed', '-n', '1p;4p', '/x/f.ts'], '/x'),
    ).toBe(null)
    expect(classifyBashReadCommand(['sed', '1,2p', '/x/f.ts'], '/x')).toBe(null)
  })

  test('grep needs -n and exactly pattern + one file', () => {
    expect(
      classifyBashReadCommand(['grep', '-n', 'pat', '/x/f.ts'], '/x'),
    ).toMatchObject({ kind: 'sparse', path: '/x/f.ts' })
    expect(classifyBashReadCommand(['grep', 'pat', '/x/f.ts'], '/x')).toBe(null)
    expect(classifyBashReadCommand(['grep', '-n', 'pat', 'a', 'b'], '/x')).toBe(
      null,
    )
    expect(
      classifyBashReadCommand(
        ['grep', '-n', '--color', 'pat', '/x/f.ts'],
        '/x',
      ),
    ).toBe(null)
  })

  test('rg needs -n and exactly pattern + one file', () => {
    expect(
      classifyBashReadCommand(['rg', '-n', 'pat', '/x/f.ts'], '/x'),
    ).toMatchObject({ kind: 'sparse', path: '/x/f.ts' })
    expect(classifyBashReadCommand(['rg', 'pat', '/x/f.ts'], '/x')).toBe(null)
    // Bundled single-char flags are allowed when every letter is allowlisted
    // and one of them is -n.
    expect(
      classifyBashReadCommand(['rg', '-in', 'pat', '/x/f.ts'], '/x'),
    ).toMatchObject({ kind: 'sparse' })
    expect(classifyBashReadCommand(['rg', '-i', 'pat', '/x/f.ts'], '/x')).toBe(
      null,
    )
    // Long flags change the rows or mean something else: fail closed.
    expect(
      classifyBashReadCommand(['rg', '-n', '-A', '2', 'pat', '/x/f.ts'], '/x'),
    ).toBe(null)
    expect(
      classifyBashReadCommand(
        ['rg', '--no-line-number', 'pat', '/x/f.ts'],
        '/x',
      ),
    ).toBe(null)
    expect(classifyBashReadCommand(['rg', '-n', 'pat', 'a', 'b'], '/x')).toBe(
      null,
    )
  })

  test('unknown readers fail closed', () => {
    expect(classifyBashReadCommand(['tail', '/x/f.ts'], '/x')).toBe(null)
    expect(classifyBashReadCommand(['less', '/x/f.ts'], '/x')).toBe(null)
  })
})

describe('recordBashReadSighting', () => {
  test('cat of a whole file records a whole-file sighting', async () => {
    const file = await tempFile('f.txt', 'a\nb\nc')
    try {
      const cache = newCache()
      recordBashReadSighting(cache, `cat ${file}`, 'a\nb\nc', '/x')
      const entry = cache.get(file)
      expect(entry?.source).toBe('bash')
      expect(entry?.seenRanges).toBeUndefined()
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('truncated output shrinks the recorded range', async () => {
    const file = await tempFile('f.txt', 'a\nb\nc\nd')
    try {
      const cache = newCache()
      // BashTool cut the tail: only the first two lines reached the model.
      recordBashReadSighting(cache, `cat ${file}`, 'a\nb', '/x')
      expect(cache.get(file)?.seenRanges).toEqual([{ start: 1, end: 2 }])
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('sed -n window records exactly the window', async () => {
    const file = await tempFile('f.txt', 'l1\nl2\nl3\nl4')
    try {
      const cache = newCache()
      recordBashReadSighting(cache, `sed -n 2,3p ${file}`, 'l2\nl3', '/x')
      expect(cache.get(file)?.seenRanges).toEqual([{ start: 2, end: 3 }])
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('grep -n rows are verified against disk', async () => {
    const file = await tempFile('f.txt', 'a\nb\nc')
    try {
      const cache = newCache()
      recordBashReadSighting(cache, `grep -n b ${file}`, '2:b', '/x')
      expect(cache.get(file)?.seenRanges).toEqual([{ start: 2, end: 2 }])

      // A row that does not agree with disk (e.g. tampered output) records
      // nothing at all.
      const cache2 = newCache()
      recordBashReadSighting(cache2, `grep -n b ${file}`, '2:WRONG', '/x')
      expect(cache2.get(file)).toBeUndefined()
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('rg -n rows are verified against disk', async () => {
    const file = await tempFile('f.txt', 'a\nb\nc')
    try {
      const cache = newCache()
      recordBashReadSighting(cache, `rg -n b ${file}`, '2:b', '/x')
      expect(cache.get(file)?.seenRanges).toEqual([{ start: 2, end: 2 }])

      // Elided rows (e.g. --max-columns) are not `num:content` anymore,
      // which aborts the whole sighting.
      const cache2 = newCache()
      recordBashReadSighting(
        cache2,
        `rg -n b ${file}`,
        '2:b\n[Omitted long matching line]',
        '/x',
      )
      expect(cache2.get(file)).toBeUndefined()
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('pipelines and redirects record nothing', async () => {
    const file = await tempFile('f.txt', 'a\nb\nc')
    try {
      const cache = newCache()
      recordBashReadSighting(cache, `cat ${file} | head -1`, 'a', '/x')
      recordBashReadSighting(cache, `cat ${file} > /dev/null`, '', '/x')
      expect(cache.get(file)).toBeUndefined()
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })
})

describe('recordGrepContentSightings', () => {
  test('content rows mark exactly the shown lines', async () => {
    const file = await tempFile('f.txt', 'one\ntwo\nthree')
    try {
      const cache = newCache()
      recordGrepContentSightings(cache, [`${file}:2:two`, `${file}-3-three`], {
        multiline: false,
      })
      const entry = cache.get(file)
      expect(entry?.source).toBe('grep')
      // Adjacent rows merge into one range.
      expect(entry?.seenRanges).toEqual([{ start: 2, end: 3 }])
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('rows elided by --max-columns are not marked seen', async () => {
    const file = await tempFile('f.txt', 'one\ntwo\nthree')
    try {
      const cache = newCache()
      // ripgrep showed line 2 truncated on disk and line 3 verbatim.
      recordGrepContentSightings(
        cache,
        [`${file}:2:tw…[truncated]`, `${file}:3:three`],
        {
          multiline: false,
        },
      )
      expect(cache.get(file)?.seenRanges).toEqual([{ start: 3, end: 3 }])
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('multiline mode records nothing', async () => {
    const file = await tempFile('f.txt', 'one\ntwo')
    try {
      const cache = newCache()
      recordGrepContentSightings(cache, [`${file}:1:one`], {
        multiline: true,
      })
      expect(cache.get(file)).toBeUndefined()
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })
})

describe('recordSighting merging with prior entries', () => {
  test('a grep after a whole-file sighting does not narrow it', async () => {
    const file = await tempFile('f.txt', 'one\ntwo\nthree')
    try {
      const cache = newCache()
      // Prior whole-file Read of the same bytes.
      cache.set(file, {
        content: 'one\ntwo\nthree',
        timestamp: 0,
        offset: 1,
        limit: undefined,
        seenRanges: undefined,
        source: 'read',
      })
      recordGrepContentSightings(cache, [`${file}:2:two`], {
        multiline: false,
      })
      const entry = cache.get(file)
      // Still whole-file seen — the smaller sighting merges in, it does not
      // overwrite.
      expect(entry?.seenRanges).toBeUndefined()
      expect(entry?.source).toBe('read')
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('sightings on the same bytes union their seen ranges', async () => {
    const file = await tempFile('f.txt', 'one\ntwo\nthree\nfour')
    try {
      const cache = newCache()
      cache.set(file, {
        content: 'one\ntwo\nthree\nfour',
        timestamp: 0,
        offset: 3,
        limit: 1,
        seenRanges: [{ start: 3, end: 3 }],
        source: 'read',
      })
      recordGrepContentSightings(cache, [`${file}:1:one`], {
        multiline: false,
      })
      expect(cache.get(file)?.seenRanges).toEqual([
        { start: 1, end: 1 },
        { start: 3, end: 3 },
      ])
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })

  test('a changed file records only the fresh sighting', async () => {
    const file = await tempFile('f.txt', 'one\ntwo\nthree')
    try {
      const cache = newCache()
      cache.set(file, {
        content: 'DIFFERENT bytes',
        timestamp: 0,
        offset: 1,
        limit: undefined,
        seenRanges: undefined,
        source: 'read',
      })
      recordGrepContentSightings(cache, [`${file}:2:two`], {
        multiline: false,
      })
      const entry = cache.get(file)
      expect(entry?.source).toBe('grep')
      expect(entry?.seenRanges).toEqual([{ start: 2, end: 2 }])
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  })
})
