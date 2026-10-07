import { describe, expect, test } from 'bun:test'
import { findBuddyTriggerPositions } from '../../src/buddy/keyword.js'

describe('findBuddyTriggerPositions', () => {
  test('matches /buddy at start of text', () => {
    expect(findBuddyTriggerPositions('/buddy')).toEqual([
      { word: '/buddy', start: 0, end: 6 },
    ])
  })

  test('matches /buddy after whitespace', () => {
    expect(findBuddyTriggerPositions('run /buddy now')).toEqual([
      { word: '/buddy', start: 4, end: 10 },
    ])
  })

  test('is case-insensitive', () => {
    expect(findBuddyTriggerPositions('/BUDDY pet')).toEqual([
      { word: '/BUDDY', start: 0, end: 6 },
    ])
  })

  test('does not match mid-word or suffix occurrences', () => {
    expect(findBuddyTriggerPositions('foo/buddy')).toEqual([])
    expect(findBuddyTriggerPositions('/buddies')).toEqual([])
  })

  test('finds multiple occurrences', () => {
    expect(findBuddyTriggerPositions('/buddy and /buddy pet')).toHaveLength(2)
  })

  test('returns empty for text without the command', () => {
    expect(findBuddyTriggerPositions('buddy without slash')).toEqual([])
  })
})
