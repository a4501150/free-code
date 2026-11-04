import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import {
  getSubagentGuidanceAttachment,
  type Attachment,
} from '../../src/utils/attachments.js'

const SUBAGENT = 'a1234567890abcdef' as const

function attachMessage(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

function contextWithTools(
  toolNames: string[],
  agentId?: string,
): ToolUseContext {
  return {
    agentId,
    options: {
      tools: toolNames.map(name => ({ name })),
    },
  } as unknown as ToolUseContext
}

const FULL_POOL = ['Bash', 'Monitor', 'SendMessage', 'EndTurn']

describe('getSubagentGuidanceAttachment', () => {
  test('silent on the main thread', () => {
    expect(
      getSubagentGuidanceAttachment(contextWithTools(FULL_POOL), undefined),
    ).toEqual([])
  })

  test('announces subagent run mechanics for a subagent with a full pool', () => {
    const result = getSubagentGuidanceAttachment(
      contextWithTools(FULL_POOL, SUBAGENT),
      undefined,
    )
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('session_guidance')
    const text = result[0].text
    expect(text).toContain('# Subagent run mechanics')
    expect(text).toContain('run ends only when you call the EndTurn tool')
    expect(text).toContain('parks and wakes when the task signals')
    expect(text).toContain('a second consecutive one ends the run')
    expect(text).toContain('SendMessage')
    expect(text).toContain('to "parent"')
    expect(text).toContain('Do not end your run just to ask a question')
  })

  test('background-task bullets only when Bash is in the pool', () => {
    const text = getSubagentGuidanceAttachment(
      contextWithTools(['SendMessage', 'EndTurn'], SUBAGENT),
      undefined,
    )[0].text
    expect(text).not.toContain('parks and wakes')
    expect(text).toContain('to "parent"')
  })

  test('parent-messaging bullet only when SendMessage is in the pool', () => {
    const text = getSubagentGuidanceAttachment(
      contextWithTools(['Bash', 'EndTurn'], SUBAGENT),
      undefined,
    )[0].text
    expect(text).toContain('parks and wakes when the task signals')
    expect(text).not.toContain('to "parent"')
  })

  test('identical announcement already in the transcript stays silent', () => {
    const context = contextWithTools(FULL_POOL, SUBAGENT)
    const first = getSubagentGuidanceAttachment(context, undefined)
    expect(first).toHaveLength(1)
    // The next announce scans the transcript containing that announcement.
    expect(
      getSubagentGuidanceAttachment(context, [attachMessage(first[0])]),
    ).toEqual([])
  })

  test('a different last session_guidance announcement (fork of a main thread) is replaced', () => {
    const context = contextWithTools(FULL_POOL, SUBAGENT)
    const inheritedMainGuidance: Attachment = {
      type: 'session_guidance',
      text: '# Session-specific guidance\n- main thread bullet',
    }
    const result = getSubagentGuidanceAttachment(context, [
      attachMessage(inheritedMainGuidance),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].text).toContain('# Subagent run mechanics')
  })
})
