import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import { InvokeTool } from '../../src/tools/InvokeToolTool/InvokeToolTool.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'

function mcpTool(
  name: string,
  inputJSONSchema: Record<string, unknown> = {
    type: 'object',
    properties: {},
  },
  checkPermissions?: Tool['checkPermissions'],
): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: name.slice('mcp__srv__'.length) },
    inputJSONSchema,
    async prompt() {
      return `description of ${name}`
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    ...(checkPermissions ? { checkPermissions } : {}),
  } as unknown as Tool
}

function builtInTool(name: string): Tool {
  return {
    name,
    isMcp: false,
    inputJSONSchema: { type: 'object', properties: {} },
    async prompt() {
      return `description of ${name}`
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
  } as unknown as Tool
}

function contextWith(
  tools: Tool[],
  permissionContext: Partial<ToolPermissionContext> = {},
): ToolUseContext {
  return {
    options: { tools, mcpClients: [] },
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        ...permissionContext,
      },
    }),
  } as unknown as ToolUseContext
}

const PASSTHROUGH = async (): Promise<{
  behavior: 'passthrough'
  message: string
}> => ({
  behavior: 'passthrough',
  message: 'Permission requested.',
})

async function invokeCheckPermissions(
  toolName: string,
  ctx: ToolUseContext,
  args: Record<string, unknown> = {},
) {
  return InvokeTool.checkPermissions({ tool: toolName, args }, ctx)
}

describe('InvokeTool validation', () => {
  test('unknown tool name is rejected', async () => {
    const ctx = contextWith([mcpTool('mcp__srv__a')])
    const result = await InvokeTool.validateInput(
      { tool: 'mcp__other__a' },
      ctx,
    )
    expect(result.result).toBe(false)
    if (!result.result) {
      expect(result.message).toContain('Unknown tool "mcp__other__a"')
    }
  })

  test('directly callable built-in is rejected', async () => {
    const ctx = contextWith([builtInTool('Fake')])
    const result = await InvokeTool.validateInput({ tool: 'Fake' }, ctx)
    expect(result.result).toBe(false)
    if (!result.result) {
      expect(result.message).toContain('already directly available')
    }
  })

  test('missing required argument is rejected with the key name', async () => {
    const ctx = contextWith([
      mcpTool('mcp__srv__a', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path', 'limit'],
      }),
    ])
    const result = await InvokeTool.validateInput(
      { tool: 'mcp__srv__a', args: { path: 'x' } },
      ctx,
    )
    expect(result.result).toBe(false)
    if (!result.result) {
      expect(result.message).toContain('Missing required argument(s)')
      expect(result.message).toContain('limit')
      expect(result.message).not.toContain('path, limit')
    }
  })

  test('present required arguments pass validation', async () => {
    const ctx = contextWith([
      mcpTool('mcp__srv__a', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
    ])
    const result = await InvokeTool.validateInput(
      { tool: 'mcp__srv__a', args: { path: 'x' } },
      ctx,
    )
    expect(result.result).toBe(true)
  })
})

describe('InvokeTool permissions', () => {
  test('unknown tool denies', async () => {
    const ctx = contextWith([mcpTool('mcp__srv__a')])
    const result = await invokeCheckPermissions('mcp__nope__x', ctx)
    expect(result.behavior).toBe('deny')
  })

  test('server-level deny rule denies the inner tool', async () => {
    const ctx = contextWith([mcpTool('mcp__srv__a')], {
      alwaysDenyRules: { session: ['mcp__srv'] },
    })
    const result = await invokeCheckPermissions('mcp__srv__a', ctx)
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.decisionReason).toMatchObject({
        rule: { ruleValue: { toolName: 'mcp__srv' } },
      })
    }
  })

  test('tool-level ask rule asks', async () => {
    const ctx = contextWith([mcpTool('mcp__srv__a', undefined, PASSTHROUGH)], {
      alwaysAskRules: { session: ['mcp__srv__a'] },
    })
    const result = await invokeCheckPermissions('mcp__srv__a', ctx)
    expect(result.behavior).toBe('ask')
  })

  test('inner tool decision wins over missing allow rule', async () => {
    const innerAsk = async () => ({
      behavior: 'ask' as const,
      message: 'Inner wants to ask.',
    })
    const ctx = contextWith([mcpTool('mcp__srv__a', undefined, innerAsk)])
    const result = await invokeCheckPermissions('mcp__srv__a', ctx)
    expect(result.behavior).toBe('ask')
  })

  test('previously-allowed inner rule auto-allows the dispatch', async () => {
    const ctx = contextWith([mcpTool('mcp__srv__a', undefined, PASSTHROUGH)], {
      alwaysAllowRules: { session: ['mcp__srv'] },
    })
    const result = await invokeCheckPermissions('mcp__srv__a', ctx)
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toEqual({ tool: 'mcp__srv__a', args: {} })
    }
  })

  test('passthrough with no rules stays passthrough', async () => {
    const ctx = contextWith([mcpTool('mcp__srv__a', undefined, PASSTHROUGH)])
    const result = await invokeCheckPermissions('mcp__srv__a', ctx)
    expect(result.behavior).toBe('passthrough')
  })

  test('throwing inner checkPermissions falls back to passthrough', async () => {
    const boom = (async () => {
      throw new Error('nope')
    }) as Tool['checkPermissions']
    const ctx = contextWith([mcpTool('mcp__srv__a', undefined, boom)])
    const result = await invokeCheckPermissions('mcp__srv__a', ctx)
    expect(result.behavior).toBe('passthrough')
  })
})

describe('InvokeTool dispatch', () => {
  let previousConfigDir: string | undefined
  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.FREECODE_CONFIG_DIR
    } else {
      process.env.FREECODE_CONFIG_DIR = previousConfigDir
    }
    resetSettingsCache()
  })

  test('call delegates args, context and progress to the inner tool', async () => {
    let seen: {
      args: unknown
      ctx: unknown
      canUseTool: unknown
      onProgress: unknown
    } | null = null
    const inner = mcpTool('mcp__srv__a')
    inner.call = (async (
      args: unknown,
      ctx: unknown,
      canUseTool: unknown,
      _msg: unknown,
      onProgress: unknown,
    ) => {
      seen = { args, ctx, canUseTool, onProgress }
      return { data: 'inner result' }
    }) as Tool['call']
    const ctx = contextWith([inner])
    const progress = () => {}
    const canUseTool = () => {}
    const result = await InvokeTool.call(
      { tool: 'mcp__srv__a', args: { path: '/x' } },
      ctx,
      canUseTool as never,
      undefined,
      progress as never,
    )
    expect(result).toEqual({ data: 'inner result' })
    expect(seen).not.toBeNull()
    expect(seen!.args).toEqual({ path: '/x' })
    expect(seen!.ctx).toBe(ctx)
    expect(seen!.canUseTool).toBe(canUseTool)
    expect(seen!.onProgress).toBe(progress)
  })

  test('lazy built-in named in lazyTools is dispatchable', async () => {
    previousConfigDir = process.env.FREECODE_CONFIG_DIR
    const dir = await mkdtemp(join(tmpdir(), 'invoke-tool-lazy-'))
    await writeFile(
      join(dir, 'freecode.json'),
      JSON.stringify({ lazyTools: ['Fake'] }),
    )
    process.env.FREECODE_CONFIG_DIR = dir
    resetSettingsCache()

    let calledWith: unknown = null
    const fake = builtInTool('Fake')
    fake.call = (async (args: unknown) => {
      calledWith = args
      return { data: 'fake ran' }
    }) as Tool['call']
    const ctx = contextWith([fake])

    const validated = await InvokeTool.validateInput(
      { tool: 'Fake', args: { q: 1 } },
      ctx,
    )
    expect(validated.result).toBe(true)

    const result = await InvokeTool.call(
      { tool: 'Fake', args: { q: 1 } },
      ctx,
      () => {},
      undefined,
      undefined,
    )
    expect(result).toEqual({ data: 'fake ran' })
    expect(calledWith).toEqual({ q: 1 })
  })
})
