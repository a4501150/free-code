import { beforeEach, describe, expect, test } from 'bun:test'
import type { DomainStreamEvent } from '../../src/types/domain.js'
import {
  getIsCompacting,
  getStreamActivity,
  recordStreamActivity,
  setIsCompacting,
  setStreamActivityListener,
} from '../../src/utils/streamActivity.js'

const ev = (e: Record<string, unknown>) =>
  recordStreamActivity(e as unknown as DomainStreamEvent)

/**
 * Characterization: the phase mirror the hosted surfaces read. The
 * transitions must match handleMessageFromStream's vocabulary, and the
 * listener is change-only so per-delta events stay cheap.
 */
describe('stream activity', () => {
  beforeEach(() => {
    setStreamActivityListener(undefined)
    setIsCompacting(false)
    ev({ type: 'message_stop' })
  })

  test('stream events mirror the spinner phases', () => {
    ev({ type: 'message_start', message: {} })
    expect(getStreamActivity()).toBe('requesting')

    ev({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'reasoning' },
    })
    expect(getStreamActivity()).toBe('thinking')

    ev({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use' },
    })
    expect(getStreamActivity()).toBe('tool-input')

    ev({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    })
    expect(getStreamActivity()).toBe('responding')

    ev({ type: 'message_stop' })
    expect(getStreamActivity()).toBe('tool-use')
  })

  test('unknown event kinds leave the phase untouched', () => {
    ev({ type: 'message_start', message: {} })
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } })
    expect(getStreamActivity()).toBe('requesting')
  })

  test('compacting notifies only on change', () => {
    let notifications = 0
    setStreamActivityListener(() => notifications++)

    setIsCompacting(true)
    expect(getIsCompacting()).toBe(true)
    expect(notifications).toBe(1)

    setIsCompacting(true)
    expect(notifications).toBe(1)

    setIsCompacting(false)
    expect(getIsCompacting()).toBe(false)
    expect(notifications).toBe(2)
  })
})
