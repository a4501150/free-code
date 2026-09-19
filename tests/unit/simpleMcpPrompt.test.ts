import { describe, expect, test } from 'bun:test'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import type { Tool } from '../../src/Tool.js'
import { getSystemPrompt } from '../../src/constants/prompts.js'
import { getMcpInstructionsDeltaAttachment } from '../../src/utils/attachments.js'
import type { Attachment } from '../../src/utils/attachments.js'

function mcpTool(serverName: string): Tool {
  return {
    name: `mcp__${serverName}__lookup`,
    isMcp: true,
    mcpInfo: { serverName, toolName: 'lookup' },
  } as Tool
}

const clients = [
  {
    type: 'connected',
    name: 'visible-server',
    instructions: 'VISIBLE MCP INSTRUCTIONS',
  },
  {
    type: 'connected',
    name: 'hidden-server',
    instructions: 'HIDDEN MCP INSTRUCTIONS',
  },
] as MCPServerConnection[]

async function inSimpleMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = previous
    }
  }
}

function renderedInstructions(atts: Attachment[]): string {
  return atts
    .filter(a => a.type === 'mcp_instructions_delta')
    .flatMap(a => (a.type === 'mcp_instructions_delta' ? a.addedBlocks : []))
    .join('\n')
}

describe('MCP instructions ride attachments, not the system prompt', () => {
  test('simple-mode system prompt carries no server instructions', async () => {
    const prompt = await inSimpleMode(() =>
      getSystemPrompt([mcpTool('visible-server')]),
    )
    const rendered = prompt.join('\n')

    expect(rendered).not.toContain('VISIBLE MCP INSTRUCTIONS')
    expect(rendered).not.toContain('HIDDEN MCP INSTRUCTIONS')
  })

  test('delta announce includes instructions only for exposed MCP tool servers', () => {
    const rendered = renderedInstructions(
      getMcpInstructionsDeltaAttachment(
        clients,
        [mcpTool('visible-server')],
        [],
      ),
    )

    expect(rendered).toContain('VISIBLE MCP INSTRUCTIONS')
    expect(rendered).not.toContain('HIDDEN MCP INSTRUCTIONS')
  })

  test('delta announce is empty when no MCP tools are exposed', () => {
    expect(getMcpInstructionsDeltaAttachment(clients, [], [])).toEqual([])
  })
})
