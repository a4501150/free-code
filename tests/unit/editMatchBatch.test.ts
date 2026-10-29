import { describe, expect, test } from 'bun:test'
import { planEdit, planEditBatch } from '../../src/utils/editMatch.js'

describe('planEdit — anchor-range mode (end_string)', () => {
  const file = 'header\nSTART\nmiddle\nmore middle\nEND\nfooter'

  function anchored(
    fileText: string,
    start: string,
    end: string,
    newString: string,
  ) {
    return planEdit(fileText, {
      oldString: start,
      newString,
      replaceAll: false,
      endString: end,
    })
  }

  test('replaces from the start anchor through the end anchor inclusive', () => {
    const r = anchored(file, 'START', 'END', 'NEW BLOCK')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.updatedContent).toBe('header\nNEW BLOCK\nfooter')
    expect(r.plan.spans).toHaveLength(1)
    expect(r.plan.spans[0]!.startLine).toBe(2)
    expect(r.plan.spans[0]!.endLine).toBe(5)
  })

  test('adjacent anchors replace an empty span (insert between)', () => {
    const r = anchored('a\nMID\nb', 'a', 'b', 'a\nMID\ninserted\nb')
    expect(r.ok && r.plan.updatedContent).toBe('a\nMID\ninserted\nb')
  })

  test('ambiguous start anchor fails with the candidate lines', () => {
    const r = anchored('dup\nx\ndup\nend', 'dup', 'end', 'n')
    expect(!r.ok && r.failure.errorCode).toBe(9)
    expect(!r.ok && r.failure.message).toContain('2 matches')
  })

  test('missing end anchor fails with errorCode 8', () => {
    const r = anchored('a\nb', 'a', 'zzz', 'n')
    expect(!r.ok && r.failure.errorCode).toBe(8)
    expect(!r.ok && r.failure.message).toContain('End anchor not found')
  })

  test('end anchor before start anchor fails with errorCode 11', () => {
    const r = anchored('a\nb\nc', 'b', 'a', 'n')
    expect(!r.ok && r.failure.errorCode).toBe(11)
  })

  test('empty new_string deletes the span and its trailing line break', () => {
    const r = anchored('header\nSTART\nmid\nEND\nfooter', 'START', 'END', '')
    expect(r.ok && r.plan.updatedContent).toBe('header\nfooter')
  })

  test('replace_all is rejected with end_string', () => {
    const r = planEdit(file, {
      oldString: 'START',
      newString: 'x',
      replaceAll: true,
      endString: 'END',
    })
    expect(!r.ok && r.failure.errorCode).toBe(1)
  })

  test('empty old_string is rejected instead of looping', () => {
    const r = planEdit('a\nb', {
      oldString: '',
      newString: 'x',
      replaceAll: false,
    })
    expect(!r.ok && r.failure.errorCode).toBe(3)
  })
})

describe('planEditBatch', () => {
  const file = 'one\ntwo\nthree\nfour\nfive'

  function batch(
    fileText: string,
    reqs: Array<{ o: string; n: string; all?: boolean; end?: string }>,
  ) {
    return planEditBatch(
      fileText,
      reqs.map(r => ({
        oldString: r.o,
        newString: r.n,
        replaceAll: r.all ?? false,
        ...(r.end !== undefined && { endString: r.end }),
      })),
    )
  }

  test('applies all entries against the original content', () => {
    const r = batch(file, [
      { o: 'one', n: 'ONE' },
      { o: 'three', n: 'THREE' },
      { o: 'five', n: 'FIVE' },
    ])
    expect(r.ok && r.plan.updatedContent).toBe('ONE\ntwo\nTHREE\nfour\nFIVE')
    expect(r.ok && r.plan.spans).toHaveLength(3)
  })

  test('any failing entry rejects the whole batch with its index', () => {
    const r = batch(file, [
      { o: 'one', n: 'ONE' },
      { o: 'zzz', n: 'X' },
    ])
    expect(!r.ok && r.failure.message).toContain('Edit 2 of 2')
    expect(!r.ok && r.failure.message).toContain('not found')
  })

  test('ambiguous entry rejects the whole batch', () => {
    const dup = 'dup\nkeep\ndup\nkeep2'
    const r = batch(dup, [
      { o: 'keep', n: 'K' },
      { o: 'dup', n: 'D' },
    ])
    expect(!r.ok && r.failure.errorCode).toBe(9)
  })

  test('overlapping entries across the batch fail with errorCode 12', () => {
    const r = batch(file, [
      { o: 'two\nthree', n: 'X' },
      { o: 'three\nfour', n: 'Y' },
    ])
    expect(!r.ok && r.failure.errorCode).toBe(12)
    expect(!r.ok && r.failure.message).toContain('overlap')
  })

  test('entries are validated against the original content, not sequentially', () => {
    const r = batch('dup\ndup\ndup', [
      { o: 'dup', n: 'x', all: true },
      { o: 'x\nx', n: 'pair' },
    ])
    // Second entry's old_string only exists after the first is applied;
    // batch validates against the ORIGINAL content, so it must fail.
    expect(!r.ok).toBe(true)
  })

  test('disjoint entries applied in one pass keep untouched bytes identical', () => {
    const r = batch('a\nb\nc\nd', [
      { o: 'a', n: 'A' },
      { o: 'b', n: 'B' },
    ])
    expect(r.ok && r.plan.updatedContent).toBe('A\nB\nc\nd')
  })

  test('anchored entries work inside a batch', () => {
    const r = batch('head\nS\nmid\nE\ntail\nx\ny', [
      { o: 'S', n: 'NEW', end: 'E' },
      { o: 'tail', n: 'TAIL' },
    ])
    expect(r.ok && r.plan.updatedContent).toBe('head\nNEW\nTAIL\nx\ny')
  })

  test('empty batch fails', () => {
    const r = planEditBatch(file, [])
    expect(!r.ok && r.failure.message).toContain('No edits')
  })
})
