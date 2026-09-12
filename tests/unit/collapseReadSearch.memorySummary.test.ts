import { describe, expect, test } from 'bun:test'
import { getSearchReadSummaryText } from '../../src/utils/collapseReadSearch.js'

describe('memory search summary text', () => {
  test('names the searched pattern so the row is debuggable', () => {
    expect(
      getSearchReadSummaryText(0, 0, false, 0, {
        memorySearchCount: 1,
        memoryReadCount: 0,
        memoryWriteCount: 0,
        memorySearchArgs: ['"memories"'],
      }),
    ).toBe('Searched memories for "memories"')
  })

  test('falls back to the bare label without args, and counts multiple', () => {
    expect(
      getSearchReadSummaryText(0, 0, false, 0, {
        memorySearchCount: 1,
        memoryReadCount: 0,
        memoryWriteCount: 0,
      }),
    ).toBe('Searched memories')
    const multiple = getSearchReadSummaryText(0, 0, false, 0, {
      memorySearchCount: 3,
      memoryReadCount: 0,
      memoryWriteCount: 0,
      memorySearchArgs: ['"a"', '"b"', '"c"'],
    })
    expect(multiple).toBe('Searched memories for 3 patterns')
  })

  test('team memory search names its pattern too', () => {
    expect(
      getSearchReadSummaryText(0, 0, false, 0, {
        memorySearchCount: 0,
        memoryReadCount: 0,
        memoryWriteCount: 0,
        teamMemorySearchCount: 1,
        teamMemorySearchArgs: ['$ rg deploy memories/'],
      }),
    ).toBe('Searched team memories for $ rg deploy memories/')
  })
})
