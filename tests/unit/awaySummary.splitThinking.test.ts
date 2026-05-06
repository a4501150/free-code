import { describe, expect, test } from 'bun:test'
import { splitThinkingFromSummary } from '../../src/services/awaySummary.js'

describe('splitThinkingFromSummary', () => {
  test('returns plain text untouched when no thinking tags present', () => {
    const r = splitThinkingFromSummary('Hello world')
    expect(r.thinking).toBeUndefined()
    expect(r.content).toBe('Hello world')
  })

  test('extracts a single thinking block', () => {
    const r = splitThinkingFromSummary(
      '<thinking>\nThe user wants a brief summary.\n</thinking>\n\nYou are debugging a bid flow.',
    )
    expect(r.thinking).toBe('The user wants a brief summary.')
    expect(r.content).toBe('You are debugging a bid flow.')
  })

  test('joins multiple thinking blocks with a blank line', () => {
    const r = splitThinkingFromSummary(
      '<thinking>first</thinking>middle<thinking>second</thinking>tail',
    )
    expect(r.thinking).toBe('first\n\nsecond')
    expect(r.content).toBe('middletail')
  })

  test('handles inline thinking and is case-insensitive', () => {
    const r = splitThinkingFromSummary(
      'before <Thinking>scratchpad</Thinking> after',
    )
    expect(r.thinking).toBe('scratchpad')
    expect(r.content).toBe('before  after')
  })

  test('returns undefined thinking when only whitespace inside tags', () => {
    const r = splitThinkingFromSummary('<thinking>   \n\n  </thinking>summary')
    expect(r.thinking).toBeUndefined()
    expect(r.content).toBe('summary')
  })
})
