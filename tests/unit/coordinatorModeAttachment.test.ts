import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import {
  getCoordinatorModeAttachment,
  type Attachment,
} from '../../src/utils/attachments.js'
import { buildCoordinatorModeBlock } from '../../src/coordinator/coordinatorMode.js'
import { mergeAndFilterTools } from '../../src/utils/toolPool.js'
import { filterToolsForAgent } from '../../src/tools/AgentTool/agentToolUtils.js'
import type { Tool } from '../../src/Tool.js'
import { setCoordinatorModeOverride } from '../../src/coordinator/coordinatorModeGate.js'
import { AGENT_REPORT_CONTRACT } from '../../src/coordinator/agentReportContract.js'

function attachMessage(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

function contextWithMcp(names: string[]): ToolUseContext {
  return {
    options: {
      tools: [],
      mcpClients: names.map(name => ({ name })),
    },
  } as unknown as ToolUseContext
}

describe('coordinator_mode attachment', () => {
  test('block carries delegation guidance, the report contract, MCP servers and the scratchpad', () => {
    const text = buildCoordinatorModeBlock({
      mcpServerNames: ['agent-browser', 'vscode-mcp'],
      scratchpadDir: '/tmp/scratch',
    })
    expect(text).toContain('# Coordinator Mode')
    expect(text).toContain('delegate substantive work')
    expect(text).toContain(AGENT_REPORT_CONTRACT)
    expect(text).toContain('agent-browser, vscode-mcp')
    expect(text).toContain('/tmp/scratch')
    expect(text).toContain('Delegate only listed skill invocations')
    // No worker-type advertising: coordinator mode runs the normal registry.
    expect(text).not.toContain('subagent_type')
  })

  test('silent outside coordinator mode and for subagents', () => {
    setCoordinatorModeOverride(false)
    expect(getCoordinatorModeAttachment(contextWithMcp([]), [])).toEqual([])

    setCoordinatorModeOverride(true)
    const subagentCtx = {
      ...contextWithMcp([]),
      agentId: 'agent-x',
    } as ToolUseContext
    expect(getCoordinatorModeAttachment(subagentCtx, [])).toEqual([])
  })

  test('announces once and stays quiet while the block is unchanged', () => {
    setCoordinatorModeOverride(true)
    const ctx = contextWithMcp(['agent-browser'])
    const first = getCoordinatorModeAttachment(ctx, [])
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ type: 'coordinator_mode' })

    const second = getCoordinatorModeAttachment(ctx, first.map(attachMessage))
    expect(second).toEqual([])
  })

  test('re-announces wholesale when a connected server appears', () => {
    setCoordinatorModeOverride(true)
    const first = getCoordinatorModeAttachment(contextWithMcp([]), [])
    const updated = getCoordinatorModeAttachment(
      contextWithMcp(['agent-browser']),
      first.map(attachMessage),
    )
    expect(updated).toHaveLength(1)
    expect(
      (updated[0] as Extract<Attachment, { type: 'coordinator_mode' }>).text,
    ).toContain('agent-browser')

    // Post-compaction (announcement gone from the transcript) re-arms full.
    const rearmed = getCoordinatorModeAttachment(
      contextWithMcp(['agent-browser']),
      [],
    )
    expect(rearmed).toHaveLength(1)
  })

  test('coordinator mode leaves the tool pool identical to normal mode', () => {
    const pool = [
      { name: 'FileRead' },
      { name: 'Agent' },
      { name: 'mcp__agent-browser__browser_open' },
    ] as Tool[]

    setCoordinatorModeOverride(false)
    const normal = mergeAndFilterTools([], pool, 'default').map(t => t.name)
    setCoordinatorModeOverride(true)
    const coordinator = mergeAndFilterTools([], pool, 'default').map(
      t => t.name,
    )
    expect(coordinator).toEqual(normal)
    expect(coordinator).toContain('mcp__agent-browser__browser_open')

    // Async workers (which coordinator/assistant sessions force) keep MCP
    // tools directly, not only via the RunCode catalog.
    const asyncPool = filterToolsForAgent({
      tools: pool,
      isBuiltIn: true,
      isAsync: true,
    }).map(t => t.name)
    expect(asyncPool).toContain('mcp__agent-browser__browser_open')
  })
})
