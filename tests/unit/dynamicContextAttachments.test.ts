import { describe, expect, test } from 'bun:test'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import {
  getSessionGuidanceAttachment,
  getUserContextDeltaAttachment,
  scanUserContextAttachments,
  type Attachment,
} from '../../src/utils/attachments.js'
import { isLoggableMessage } from '../../src/utils/sessionStorage.js'

function attachMessage(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

function contextWithToolNames(names: string[]): ToolUseContext {
  return {
    options: {
      tools: names.map(name => ({ name }) as Tool),
      mcpClients: [],
    },
  } as ToolUseContext
}

describe('session_guidance attachment', () => {
  test('announces once and stays quiet while the text is unchanged', () => {
    const ctx = contextWithToolNames(['AskUserQuestion'])
    const first = getSessionGuidanceAttachment(ctx, [])
    expect(first.length).toBe(1)
    expect(first[0]).toMatchObject({ type: 'session_guidance' })

    const second = getSessionGuidanceAttachment(ctx, first.map(attachMessage))
    expect(second).toEqual([])
  })

  test('re-announces the full block when tool gating changes', () => {
    const ctxWithout = contextWithToolNames([])
    const ctxWith = contextWithToolNames(['AskUserQuestion'])

    // Tests run non-interactive, so the ctxWithout block may be empty or
    // without tool bullets; either way the newly gated bullet must arrive
    // as a wholesale re-announce and then go quiet.
    const first = getSessionGuidanceAttachment(ctxWithout, [])
    const updated = getSessionGuidanceAttachment(
      ctxWith,
      first.map(attachMessage),
    )
    expect(updated.length).toBe(1)
    expect(
      (updated[0] as Extract<Attachment, { type: 'session_guidance' }>).text,
    ).toContain('AskUserQuestion')

    const quiet = getSessionGuidanceAttachment(ctxWith, [
      ...first.map(attachMessage),
      ...updated.map(attachMessage),
    ])
    expect(quiet).toEqual([])
  })
})

describe('user context snapshot domains', () => {
  const memoriesSnapshot: Attachment = {
    type: 'user_context_snapshot',
    domain: 'memories',
    renderedContent: '<system-reminder>memories</system-reminder>',
    entries: [{ key: '/p/CLAUDE.md', value: 'rules' }],
  }
  const legacySnapshot: Attachment = {
    type: 'user_context_snapshot',
    renderedContent: '<system-reminder>merged</system-reminder>',
    entries: [
      { key: '/p/CLAUDE.md', value: 'rules' },
      { key: 'gitStatus', value: 'clean' },
      { key: 'env', value: 'darwin' },
    ],
  }

  test('a domain-tagged snapshot answers only its domain', () => {
    const scan = scanUserContextAttachments([attachMessage(memoriesSnapshot)])
    expect(scan.snapshotFor('memories')?.domain).toBe('memories')
    expect(scan.snapshotFor('env')).toBeNull()
  })

  test('a legacy untagged snapshot answers every domain, tagged undefined', () => {
    const scan = scanUserContextAttachments([attachMessage(legacySnapshot)])
    for (const domain of ['memories', 'system', 'env'] as const) {
      expect(scan.snapshotFor(domain)?.domain).toBeUndefined()
    }
  })

  test('a later domain-tagged snapshot replaces a legacy one', () => {
    const envSnapshot: Attachment = {
      type: 'user_context_snapshot',
      domain: 'env',
      renderedContent: '<system-reminder>env</system-reminder>',
      entries: [{ key: 'env', value: 'darwin' }],
    }
    const scan = scanUserContextAttachments([
      attachMessage(legacySnapshot),
      attachMessage(envSnapshot),
    ])
    expect(scan.snapshotFor('env')?.domain).toBe('env')
    expect(scan.snapshotFor('memories')?.domain).toBeUndefined()
  })

  test('per-domain diff against a legacy merged snapshot announces nothing when unchanged', () => {
    const scan = scanUserContextAttachments([attachMessage(legacySnapshot)])
    const delta = getUserContextDeltaAttachment(
      scan,
      [{ key: 'env', value: 'darwin' }],
      'env',
    )
    expect(delta).toEqual([])
  })

  test('deltas update the announced baseline for later diffs', () => {
    const scan = scanUserContextAttachments([
      attachMessage(legacySnapshot),
      attachMessage({
        type: 'user_context_delta',
        domain: 'env',
        replacements: [{ key: 'env', value: 'linux' }],
        removals: [],
      }),
    ])
    const delta = getUserContextDeltaAttachment(
      scan,
      [{ key: 'env', value: 'linux' }],
      'env',
    )
    expect(delta).toEqual([])
  })

  test("another domain's announced keys never announce as removals", () => {
    const envSnapshot: Attachment = {
      type: 'user_context_snapshot',
      domain: 'env',
      renderedContent: '<system-reminder>env</system-reminder>',
      entries: [{ key: 'env', value: 'darwin' }],
    }
    const scan = scanUserContextAttachments([
      attachMessage(memoriesSnapshot),
      attachMessage(envSnapshot),
    ])
    const delta = getUserContextDeltaAttachment(
      scan,
      [{ key: 'env', value: 'linux' }],
      'env',
    )
    expect(delta).toEqual([
      {
        type: 'user_context_delta',
        domain: 'env',
        replacements: [{ key: 'env', value: 'linux' }],
        removals: [],
      },
    ])
  })
})

describe('persistence allowlist', () => {
  test('instruction, guidance and context attachments survive resume', () => {
    expect(
      isLoggableMessage(
        attachMessage({
          type: 'mcp_instructions_delta',
          addedNames: ['s'],
          addedBlocks: ['## s\nrules'],
          removedNames: [],
        }),
      ),
    ).toBe(true)
    expect(
      isLoggableMessage(
        attachMessage({
          type: 'session_guidance',
          text: '# Session-specific guidance\n - x',
        }),
      ),
    ).toBe(true)
    // Still memory-only:
    expect(
      isLoggableMessage(
        attachMessage({
          type: 'skill_listing',
          content: '- demo',
          skillCount: 1,
          isInitial: true,
        }),
      ),
    ).toBe(false)
  })
})
