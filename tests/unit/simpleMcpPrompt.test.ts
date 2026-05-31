import { describe, expect, test } from 'bun:test'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import type { Tool } from '../../src/Tool.js'
import { getSystemPrompt } from '../../src/constants/prompts.js'

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

describe('simple-mode MCP prompt instructions', () => {
  test('does not advertise servers without exposed MCP tools', async () => {
    const prompt = await inSimpleMode(() =>
      getSystemPrompt([], 'test-model', undefined, clients),
    )
    const rendered = prompt.join('\n')

    expect(rendered).not.toContain('VISIBLE MCP INSTRUCTIONS')
    expect(rendered).not.toContain('HIDDEN MCP INSTRUCTIONS')
  })

  test('includes instructions only for exposed MCP tool servers', async () => {
    const prompt = await inSimpleMode(() =>
      getSystemPrompt(
        [mcpTool('visible-server')],
        'test-model',
        undefined,
        clients,
      ),
    )
    const rendered = prompt.join('\n')

    expect(rendered).toContain('VISIBLE MCP INSTRUCTIONS')
    expect(rendered).not.toContain('HIDDEN MCP INSTRUCTIONS')
  })
})
