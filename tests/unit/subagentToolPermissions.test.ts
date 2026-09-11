import { describe, test, expect } from 'bun:test'
import type { Tool, ToolUseContext, Tools } from '../../src/Tool.js'
import type { ToolPermissionContext } from '../../src/types/permissions.js'
import { hasPermissionsToUseTool } from '../../src/utils/permissions/permissions.js'
import {
  getMainLoopModel,
  runWithMainLoopModelScope,
} from '../../src/utils/model/modelResolution.js'
import { getMcpInstructions } from '../../src/constants/prompts.js'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'

function makeTool(name: string, askReason?: string): Tool {
  return {
    name,
    inputSchema: { parse: (input: unknown) => input },
    isEnabled: () => true,
    requiresUserInteraction: () => false,
    async checkPermissions() {
      return askReason
        ? {
            behavior: 'ask' as const,
            message: askReason,
            decisionReason: { type: 'safetyCheck' as const },
          }
        : {
            behavior: 'passthrough' as const,
            message: `${name} requires permission.`,
          }
    },
  } as unknown as Tool
}

function makeContext(
  overrides: Partial<ToolPermissionContext>,
): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    shouldAvoidPermissionPrompts: true,
    ...overrides,
  }
  return {
    getAppState: () => ({ toolPermissionContext }),
    abortController: new AbortController(),
  } as unknown as ToolUseContext
}

async function decide(tool: Tool, context: ToolUseContext) {
  return hasPermissionsToUseTool(
    tool,
    {},
    context,
    undefined as never,
    'toolu_test',
  )
}

describe('subagent passthrough-ask policy', () => {
  test('rule-unobjected ask auto-approves when the flag is set', async () => {
    const result = await decide(
      makeTool('mcp__agent-browser__web_fetch'),
      makeContext({ subagentAutoApproveAsks: true }),
    )
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason?.type).toBe('asyncAgent')
  })

  test('headless agents without the flag keep auto-denying', async () => {
    const result = await decide(
      makeTool('mcp__agent-browser__web_fetch'),
      makeContext({}),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('asyncAgent')
  })

  test('safety-check asks stay denied even with the flag', async () => {
    const result = await decide(
      makeTool('Edit', 'sensitive path'),
      makeContext({ subagentAutoApproveAsks: true }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('plan mode keeps the denial with the flag', async () => {
    const result = await decide(
      makeTool('mcp__agent-browser__web_fetch'),
      makeContext({ subagentAutoApproveAsks: true, mode: 'plan' }),
    )
    expect(result.behavior).toBe('deny')
  })

  test('deny rules win over the policy', async () => {
    const result = await decide(
      makeTool('mcp__agent-browser__web_fetch'),
      makeContext({
        subagentAutoApproveAsks: true,
        alwaysDenyRules: { userSettings: ['mcp__agent-browser'] },
      }),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })
})

describe('main loop model scope', () => {
  test('getMainLoopModel resolves to the scoped model and nests', () => {
    // No global default is configured in the unit env, so only assert what
    // the scope itself resolves — outer-scope restoration stands in for the
    // outside-scope behavior.
    runWithMainLoopModelScope('scopeprovider:scopemodel', () => {
      expect(getMainLoopModel()).toContain('scopemodel')
      const inner = runWithMainLoopModelScope('scopeprovider:innermodel', () =>
        getMainLoopModel(),
      )
      expect(inner).toContain('innermodel')
      // Nested scope unwinds to the outer scope, not to global state.
      expect(getMainLoopModel()).toContain('scopemodel')
    })
  })
})

describe('getMcpInstructions exposure filter', () => {
  const clients = [
    { type: 'connected', name: 'alpha', instructions: 'alpha rules' },
    { type: 'connected', name: 'beta', instructions: 'beta rules' },
  ] as unknown as MCPServerConnection[]

  test('only servers whose tools are exposed get a section', () => {
    const tools = [
      { name: 'mcp__alpha__x', mcpInfo: { serverName: 'alpha' } },
    ] as unknown as Tools
    const section = getMcpInstructions(clients, tools)
    expect(section).toContain('## alpha')
    expect(section).not.toContain('## beta')
  })

  test('no exposed MCP tools yields no section', () => {
    expect(getMcpInstructions(clients, [])).toBeNull()
  })
})
