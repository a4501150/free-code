import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Attachment } from '../../src/utils/attachments.js'
import { normalizeAttachmentForAPI } from '../../src/utils/messages.js'

/**
 * Transcript/API/user-visibility invariant: everything persisted to the
 * transcript and sent to the API must render through
 * normalizeAttachmentForAPI, and anything it drops must be a deliberate
 * inert record (persisted for audit, invisible to the model). These tests
 * pin that classification so a newly added attachment case cannot ship
 * as a silent no-op.
 */

// Smoke fixtures: one per category of "the model must see this".
const VISIBLE_FIXTURES: Array<[Attachment, string]> = [
  [
    {
      type: 'user_context_delta',
      replacements: [{ key: '/p/CLAUDE.md', value: 'new' }],
      removals: ['/p/CLAUDE.local.md'],
    },
    'session context',
  ],
  [
    {
      type: 'mcp_tools_delta',
      generation: 1,
      servers: [
        { name: 's1', file: 'servers/s1.json', toolCount: 3, hash: 'h' },
      ],
      builtins: [],
      addedNames: ['s1'],
      changedNames: [],
      removedNames: [],
      builtinsAdded: [],
      builtinsRemoved: [],
    },
    'New MCP servers are connected',
  ],
  [
    {
      type: 'mcp_instructions_delta',
      addedBlocks: ['## s1\nUse it well'],
      removedNames: [],
    },
    'MCP Server Instructions',
  ],
  [
    {
      type: 'agent_listing_delta',
      addedLines: ['- worker: does work'],
      removedTypes: [],
      isInitial: true,
      showConcurrencyNote: false,
    },
    'Available agent types',
  ],
  [
    {
      type: 'skill_listing',
      content: '- demo: a skill',
      skillCount: 1,
      isInitial: true,
    },
    'available for use with the Skill tool',
  ],
  [
    {
      type: 'edited_text_file',
      filename: '/p/a.ts',
      snippet: 'x',
    },
    'a.ts',
  ],
]

// Rendered by the API path, but shape- or feature-dependent (e.g.
// verify_plan_reminder self-suppresses when VERIFY_PLAN is off, image/pdf
// cases need real file-output payloads). Kept here so the drift-guard test
// can require every renderer case to be classified.
const VISIBLE_NOT_FIXTURE_TESTED = [
  'agent_mention',
  'async_hook_response',
  'auto_compact_imminent',
  'auto_mode',
  'auto_mode_exit',
  'budget_usd',
  'compact_file_reference',
  'critical_system_reminder',
  'date_change',
  'deferred_tools_delta',
  'diagnostics',
  'directory',
  'dynamic_skill',
  'file',
  'hook_additional_context',
  'hook_blocking_error',
  'hook_stopped_continuation',
  'hook_success',
  'image',
  'invoked_skills',
  'mcp_resource',
  'nested_memory',
  'notebook',
  'opened_file_in_ide',
  'pdf',
  'pdf_reference',
  'plan_file_reference',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'queued_command',
  'relevant_memories',
  'selected_lines_in_ide',
  'stale_task_list',
  'task_status',
  'terminal_focus',
  'text',
  'token_usage',
  'ultrathink_effort',
  // Feature-gated: renders when VERIFY_PLAN is compiled in, [] otherwise.
  'verify_plan_reminder',
]

// Inert records: persisted to the transcript (and shown by the UI), but
// carry no model-visible bytes — normalizeAttachmentForAPI must keep
// rendering them to nothing. Each is a UI/audit signal, not a prompt turn.
const INERT_FIXTURES: Attachment[] = [
  {
    type: 'already_read_file',
    filename: '/p/a.ts',
    content: {} as never, // FileReadToolOutput — unused by the [] renderer
    displayPath: 'a.ts',
  },
  { type: 'command_permissions', allowedTools: ['Bash'] },
  {
    type: 'edited_image_file',
    filename: '/p/a.png',
    content: {} as never,
  },
  {
    type: 'hook_cancelled',
    hookName: 'h',
    toolUseID: 't',
    hookEvent: 'PreToolUse',
  },
  {
    type: 'hook_error_during_execution',
    content: 'boom',
    hookName: 'h',
    toolUseID: 't',
    hookEvent: 'PreToolUse',
  },
  {
    type: 'hook_non_blocking_error',
    hookName: 'h',
    stderr: 'boom',
    stdout: '',
    exitCode: 1,
    toolUseID: 't',
    hookEvent: 'PreToolUse',
  },
  {
    type: 'hook_permission_decision',
    decision: 'allow',
    toolUseID: 't',
    hookEvent: 'PreToolUse',
  },
  {
    type: 'hook_system_message',
    content: 'shown to user only',
    hookName: 'h',
    toolUseID: 't',
    hookEvent: 'PreToolUse',
  },
  { type: 'structured_output', data: { ok: true } },
]

// Model-visible but delivered out-of-band: the snapshot's rendered bytes
// ride the synthetic first user message (query.ts snapshot prepend), not
// the history render path. It must stay silent HERE or every replay would
// duplicate the whole session context.
const OUT_OF_BAND_FIXTURES: Attachment[] = [
  {
    type: 'user_context_snapshot',
    renderedContent: '<system-reminder>ctx</system-reminder>',
    entries: [{ key: '/p/CLAUDE.md', value: 'instructions' }],
  },
]

// Union members with no renderer case at all — consumed by consumers
// (runAgent reads structured_output/max_turns_reached), handled pre-switch
// behind feature gates (teammate mailbox/team_context), or UI-only records.
const NO_RENDERER_TYPES = [
  'teammate_mailbox',
  'team_context',
  'teammate_shutdown_batch',
  'max_turns_reached',
  'current_session_memory',
]

function rendererSource(): string {
  const src = readFileSync(
    join(import.meta.dir, '../../src/utils/messages.ts'),
    'utf8',
  )
  const start = src.indexOf('export function normalizeAttachmentForAPI(')
  if (start === -1) throw new Error('normalizeAttachmentForAPI not found')
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces')
}

function rendererCases(): Set<string> {
  return new Set(
    [...rendererSource().matchAll(/case '([a-z_]+)':/g)].map(m => m[1]),
  )
}

describe('attachment renderer visibility contract', () => {
  test('visible fixtures render non-empty and contain the probe text', () => {
    for (const [attachment, probe] of VISIBLE_FIXTURES) {
      const messages = normalizeAttachmentForAPI(attachment)
      const text = messages
        .map(m =>
          typeof m.message.content === 'string'
            ? m.message.content
            : m.message.content.map(b => ('text' in b ? b.text : '')).join(''),
        )
        .join('\n')
      expect(text, attachment.type).toContain(probe)
    }
  })

  test('inert records and out-of-band snapshots render to nothing on the history path', () => {
    for (const attachment of [...INERT_FIXTURES, ...OUT_OF_BAND_FIXTURES]) {
      expect(normalizeAttachmentForAPI(attachment), attachment.type).toEqual([])
    }
  })

  test('every renderer case is classified as visible or inert', () => {
    const classified = new Set([
      ...VISIBLE_FIXTURES.map(([a]) => a.type),
      ...VISIBLE_NOT_FIXTURE_TESTED,
      ...INERT_FIXTURES.map(a => a.type),
      ...OUT_OF_BAND_FIXTURES.map(a => a.type),
    ])
    const unclassified = [...rendererCases()].filter(t => !classified.has(t))
    expect(unclassified).toEqual([])
    // And conversely no stale classification for removed cases.
    const removed = [...classified].filter(t => !rendererCases().has(t))
    expect(removed).toEqual([])
  })

  test('no-renderer types stay out of the switch, mailbox handled pre-switch', () => {
    const cases = rendererCases()
    for (const type of NO_RENDERER_TYPES) {
      expect(cases.has(type)).toBeFalse()
    }
    // teammate_mailbox/team_context render only behind the swarms gate —
    // that handling lives before the switch, so it can never be lost
    // silently.
    const src = rendererSource()
    expect(src).toContain("attachment.type === 'teammate_mailbox'")
    expect(src).toContain("attachment.type === 'team_context'")
  })
})
