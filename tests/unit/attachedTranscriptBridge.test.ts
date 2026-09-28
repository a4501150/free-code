/**
 * The wire-items -> renderable-transcript bridge and the status-line
 * derivation: the two pure decisions the attached-session viewer makes.
 */
import { describe, expect, test } from 'bun:test'
import {
  bridgeTranscript,
  isInjectedContextItem,
} from '../../src/screens/attached/transcriptBridge.js'
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

  test('injected-context rows ride like every other row, flagged injected', () => {
    const snap = snapshot([
      item({
        id: 'x1',
        kind: 'attachment',
        attachment: {
          type: 'user_context_snapshot',
          display: 'context',
          reminder: 'ctx\nline two',
        },
      }),
      item({
        id: 'x2',
        kind: 'attachment',
        attachment: { type: 'session_guidance', display: 'guidance' },
      }),
      item({
        id: 'x4',
        kind: 'attachment',
        attachment: { type: 'file', display: 'a file' },
      }),
    ])
    for (const type of ['user_context_snapshot', 'session_guidance']) {
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
    // The classic pane shows collapsed reminder rows by default, so the
    // bridge never drops them: every attachment becomes a unit.
    const bridged = bridgeTranscript(snap, false)
    expect(bridged.units).toHaveLength(3)
    const attachments = bridged.units.filter(
      u => u.kind === 'attachment' && 'item' in u,
    ) as Extract<(typeof bridged.units)[number], { kind: 'attachment' }>[]
    const byId = new Map(attachments.map(u => [u.item.id, u]))
    expect(byId.get('x1')!.injected).toBe(true)
    expect(byId.get('x2')!.injected).toBe(true)
    expect(byId.get('x4')!.injected).toBe(false)
    // The reminder body rides the unit: the transcript component needs it
    // for the real line count, and the bridge passes items through as is.
    expect(byId.get('x1')!.item.attachment?.reminder).toBe('ctx\nline two')
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
