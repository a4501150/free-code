/**
 * The wire-items -> renderable-transcript bridge and the status-line
 * derivation: the two pure decisions the attached-session viewer makes.
 */
import { describe, expect, test } from 'bun:test'
import {
  bridgeTranscript,
  isInjectedContextItem,
} from '../../src/screens/attached/transcriptBridge.js'
import { statusLineParts } from '../../src/screens/attached/itemViews.js'
import type {
  WireItem,
  WireTranscriptSnapshot,
} from '../../src/session/wire.js'

function item(
  overrides: Partial<WireItem> & { id: string; kind: WireItem['kind'] },
): WireItem {
  return { rev: 'r1', timestamp: '2026-09-28T00:00:00Z', ...overrides }
}

function snapshot(items: WireItem[]): WireTranscriptSnapshot {
  return { items, order: items.map(i => i.id) }
}

describe('bridgeTranscript', () => {
  test('assistant text and a tool call sharing a messageId regroup into one message', () => {
    const snap = snapshot([
      item({
        id: 'a1',
        kind: 'assistant',
        text: 'working',
        messageId: 'msg-1',
        model: 'm',
      }),
      item({
        id: 'a2',
        kind: 'tool_use',
        messageId: 'msg-1',
        toolUseId: 'tu-1',
        toolName: 'Bash',
        toolInput: { command: 'echo hi' },
      }),
      item({
        id: 'u2',
        kind: 'tool_result',
        toolUseId: 'tu-1',
        text: 'hi',
      }),
    ])
    const bridged = bridgeTranscript(snap, false)
    const messageUnits = bridged.units.filter(u => u.kind === 'message')
    // One assistant unit (two blocks) + one tool_result unit.
    expect(messageUnits).toHaveLength(2)
    const assistant = messageUnits[0] as Extract<
      (typeof bridged.units)[number],
      { kind: 'message' }
    >
    expect(assistant.message.type).toBe('assistant')
    const content = (
      assistant.message as { message: { content: Array<{ type: string }> } }
    ).message.content
    expect(content.map(b => b.type)).toEqual(['text', 'tool_use'])

    // The lookups the tool cards need: resolved state and the block itself.
    expect(bridged.lookups.resolvedToolUseIDs.has('tu-1')).toBe(true)
    expect(bridged.lookups.toolUseByToolUseID.get('tu-1')?.name).toBe('Bash')
  })

  test('an errored tool result marks its call errored in the lookups', () => {
    const bridged = bridgeTranscript(
      snapshot([
        item({
          id: 'a1',
          kind: 'tool_use',
          messageId: 'msg-1',
          toolUseId: 'tu-9',
          toolName: 'Bash',
          toolInput: {},
        }),
        item({
          id: 'u2',
          kind: 'tool_result',
          toolUseId: 'tu-9',
          text: 'boom',
          isError: true,
        }),
      ]),
      false,
    )
    expect(bridged.lookups.erroredToolUseIDs.has('tu-9')).toBe(true)
  })

  test('injected-context rows are hidden by default and revealed on request', () => {
    const snap = snapshot([
      item({
        id: 'x1',
        kind: 'attachment',
        attachment: { type: 'user_context_snapshot', display: 'context' },
      }),
      item({
        id: 'x2',
        kind: 'attachment',
        attachment: { type: 'session_guidance', display: 'guidance' },
      }),
      item({
        id: 'x3',
        kind: 'attachment',
        attachment: { type: 'skill_listing', display: 'skills' },
      }),
      item({
        id: 'x4',
        kind: 'attachment',
        attachment: { type: 'file', display: 'a file' },
      }),
    ])
    for (const type of [
      'user_context_snapshot',
      'session_guidance',
      'skill_listing',
    ]) {
      expect(
        isInjectedContextItem(
          item({
            id: 'i',
            kind: 'attachment',
            attachment: { type, display: '' },
          }),
        ),
      ).toBe(true)
    }
    const hidden = bridgeTranscript(snap, false)
    expect(hidden.units).toHaveLength(1) // only the `file` attachment
    expect(hidden.units[0]!.kind).toBe('attachment')

    const shown = bridgeTranscript(snap, true)
    expect(shown.units).toHaveLength(4)
  })

  test('a user item carries its text into a user message; isMeta is preserved', () => {
    const bridged = bridgeTranscript(
      snapshot([
        item({ id: 'h1', kind: 'user', text: 'hello', isMeta: false }),
        item({ id: 'h2', kind: 'user', text: '<meta>', isMeta: true }),
      ]),
      false,
    )
    const users = bridged.units.filter(u => u.kind === 'message')
    expect(users).toHaveLength(2)
    expect(users[1]!.kind === 'message' && users[1]!.message.isMeta).toBe(true)
  })

  test('system rows survive as native units; compact seams included', () => {
    const bridged = bridgeTranscript(
      snapshot([
        item({
          id: 's1',
          kind: 'system',
          text: 'Conversation compacted',
          subtype: 'compact_boundary',
        }),
      ]),
      false,
    )
    expect(bridged.units).toEqual([
      { kind: 'system', item: expect.objectContaining({ id: 's1' }) },
    ])
  })
})

describe('statusLineParts', () => {
  const meta = {
    sessionId: 's',
    sessionEpoch: 0,
    cwd: '/',
    startedAt: 0,
    state: 'idle' as const,
    model: 'glm-5.3-flash-free',
    permissionMode: 'plan' as const,
    context: { usedTokens: 30, maxTokens: 100, usedPercent: 30 },
    costUsd: 1.234,
  }

  test('reads model, mode, context and cost in order', () => {
    expect(statusLineParts(meta)).toEqual([
      'glm-5.3-flash-free',
      'plan',
      '30% context',
      '$1.23',
    ])
  })

  test('a running turn leads with the activity wording and elapsed time', () => {
    const parts = statusLineParts(
      { ...meta, state: 'running', activity: 'tool-use' },
      { elapsedMs: 4200 },
    )
    expect(parts[0]).toBe('running tools…')
    expect(parts[1]).toBe('4s')
  })

  test('a tray replaces the activity with the wait-for-you label', () => {
    const parts = statusLineParts(
      { ...meta, state: 'running', activity: 'tool-use' },
      { waitingForUser: true },
    )
    expect(parts[0]).toBe('waiting for you')
  })

  test('the default permission mode is not shown', () => {
    const parts = statusLineParts({ ...meta, permissionMode: 'default' })
    expect(parts).not.toContain('default')
  })
})
