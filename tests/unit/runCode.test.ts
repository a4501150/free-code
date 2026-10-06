/**
 * Unit tests: RunCode loader (transpile + import rewrite + AsyncFunction
 * execution) and bridge (catalog namespaces + runToolUse dispatch).
 */
import { describe, test, expect } from 'bun:test'
import { z } from 'zod/v4'
import {
  buildTool,
  type CanUseToolFn,
  type Tool,
  type ToolUseContext,
} from '../../src/Tool.js'
import { createAssistantMessage } from '../../src/utils/messages.js'
import type {
  RunCodeProgress,
  ToolProgressData,
} from '../../src/types/tools.js'
import {
  runScript,
  type NamespaceResolution,
} from '../../src/tools/RunCodeTool/loader.js'
import { createRunCodeBridge } from '../../src/tools/RunCodeTool/bridge.js'
import {
  RunCodeTool,
  renderRunCodeResultText,
} from '../../src/tools/RunCodeTool/RunCodeTool.js'

const ALLOWED: CanUseToolFn = async (_tool, input) => ({
  behavior: 'allow',
  updatedInput: input as never,
})

function passthroughNamespace(fn: (args: unknown) => Promise<string>) {
  return (_spec: string): NamespaceResolution => ({
    ok: true,
    ns: { greet: fn, other: fn },
    exports: ['greet', 'other'],
  })
}

function abortController() {
  return new AbortController()
}

describe('loader', () => {
  test('named imports bind to the resolved namespace, top-level await works, console is captured', async () => {
    const calls: unknown[] = []
    const res = await runScript(
      `
      import { greet, other as o } from "mcp/srv";
      interface Named { who: string }
      const n: Named = { who: "world" };
      const r = await greet(n);
      console.log("got", r, typeof o);
      `,
      {
        resolveNamespace: passthroughNamespace(async a => {
          calls.push(a)
          return 'hello'
        }),
        signal: abortController().signal,
      },
    )
    expect(res.ok).toBe(true)
    expect(calls).toEqual([{ who: 'world' }])
    expect(res.logs).toEqual(['got hello function'])
  })

  test('namespace imports bind the whole module object', async () => {
    const res = await runScript(
      `import * as srv from "mcp/srv"; await srv.greet({a:1});`,
      {
        resolveNamespace: passthroughNamespace(async () => 'x'),
        signal: abortController().signal,
      },
    )
    expect(res.ok).toBe(true)
  })

  test('dynamic import, default imports, and export default are rejected', async () => {
    for (const code of [
      `await import("mcp/srv");`,
      `import srv from "mcp/srv"; await srv.greet();`,
      `export default 1;`,
      `export { greet } from "mcp/srv";`,
    ]) {
      const res = await runScript(code, {
        resolveNamespace: passthroughNamespace(async () => 'x'),
        signal: abortController().signal,
      })
      expect(res.ok).toBe(false)
    }
  })

  test('unknown specifier error surfaces, missing export lists available names', async () => {
    const missing = await runScript(`import { nope } from "mcp/srv";`, {
      resolveNamespace: passthroughNamespace(async () => 'x'),
      signal: abortController().signal,
    })
    expect(missing.ok).toBe(false)
    expect((missing as { error: string }).error).toContain("'nope'")
    expect((missing as { error: string }).error).toContain('greet')

    const unknown = await runScript(`import { greet } from "other/x";`, {
      resolveNamespace: spec =>
        spec === 'mcp/srv'
          ? { ok: true, ns: {}, exports: ['greet'] }
          : {
              ok: false,
              error: 'Servers with cataloged tools: srv.',
            },
      signal: abortController().signal,
    })
    expect(unknown.ok).toBe(false)
    expect((unknown as { error: string }).error).toContain(
      'Servers with cataloged tools: srv.',
    )
  })

  test('uncaught rejection fails the script with logs preserved', async () => {
    const res = await runScript(
      `console.log("before"); throw new Error("boom");`,
      {
        resolveNamespace: passthroughNamespace(async () => 'x'),
        signal: abortController().signal,
      },
    )
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('boom')
    expect(res.logs).toEqual(['before'])
  })

  test('abort interrupts a pending script', async () => {
    const ac = abortController()
    const res = runScript(`await new Promise(() => {});`, {
      resolveNamespace: passthroughNamespace(async () => 'x'),
      signal: ac.signal,
    })
    ac.abort()
    const out = await res
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toContain('interrupted')
  })
})

describe('bridge', () => {
  const fakeServerTool = buildTool({
    name: 'mcp__srv__echo',
    inputSchema: z.object({ q: z.string() }),
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: 'echo' },
    async description() {
      return 'echo'
    },
    async call(args) {
      return { data: `echo:${(args as { q: string }).q}` }
    },
  })
  const failingTool = buildTool({
    name: 'mcp__srv__boom',
    inputSchema: z.object({}),
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: 'boom' },
    async description() {
      return 'boom'
    },
    async call() {
      throw new Error('inner exploded')
    },
  })

  function makeContext(tools: Tool[]): ToolUseContext {
    return {
      options: { tools, mcpClients: [] },
      abortController: new AbortController(),
      // sessionHooks must be a Map: the PreToolUse path reads it via
      // hasHookForEvent and treats any throw as a hook `stop`.
      getAppState: () =>
        ({
          toolPermissionContext: { mode: 'default' },
          sessionHooks: new Map(),
        }) as never,
    } as unknown as ToolUseContext
  }

  test('a script call dispatches through the pipeline, records a segment, forwards nested progress', async () => {
    const tool = { ...fakeServerTool }
    const context = makeContext([tool])
    const canUseTool: CanUseToolFn = async (...args) => {
      permissionChecks.push(args[0].name)
      return { behavior: 'allow', updatedInput: args[1] as never }
    }
    const permissionChecks: string[] = []
    const progress: ToolProgressData[] = []
    const bridge = createRunCodeBridge({
      toolUseContext: context,
      canUseTool,
      parentMessage: createAssistantMessage({ content: 'go' }),
      emitProgress: d => progress.push(d),
    })

    const out = await bridge.invoke('mcp__srv__echo', { q: 'hi' })
    expect(out).toBe('echo:hi')
    expect(bridge.segments).toEqual([
      { name: 'mcp__srv__echo', ok: true, output: 'echo:hi' },
    ])
    // Permission was evaluated against the INNER tool name.
    expect(permissionChecks).toEqual(['mcp__srv__echo'])
    // One progress for the child tool_use row, one for the tool_result row.
    const nested = progress.filter(p => p.type === 'runcode_progress')
    expect(nested.length).toBe(2)
    expect((nested[0] as RunCodeProgress).message.type === 'assistant').toBe(
      true,
    )

    const namespace = bridge.resolveNamespace('mcp/srv')
    expect(namespace.ok).toBe(true)
    expect((namespace as { exports: string[] }).exports).toEqual(['echo'])
  })

  test('a failing inner call rejects the script function but records the segment', async () => {
    const context = makeContext([{ ...failingTool }])
    const bridge = createRunCodeBridge({
      toolUseContext: context,
      canUseTool: ALLOWED,
      parentMessage: createAssistantMessage({ content: 'go' }),
      emitProgress: () => {},
    })
    await expect(bridge.invoke('mcp__srv__boom', {})).rejects.toThrow(
      /inner exploded/,
    )
    expect(bridge.segments.length).toBe(1)
    expect(bridge.segments[0]!.ok).toBe(false)
    expect(bridge.segments[0]!.error).toContain('inner exploded')
  })

  test('directly-exposed tools are refused from a script', async () => {
    const context = makeContext([
      { ...fakeServerTool },
      RunCodeTool as unknown as Tool,
    ])
    const bridge = createRunCodeBridge({
      toolUseContext: context,
      canUseTool: ALLOWED,
      parentMessage: createAssistantMessage({ content: 'go' }),
      emitProgress: () => {},
    })
    await expect(bridge.invoke('RunCode', {})).rejects.toThrow(
      /directly available/,
    )
  })
})

describe('tool result rendering', () => {
  test('sections render per call with logs appended', () => {
    const text = renderRunCodeResultText({
      segments: [
        { name: 'mcp__srv__echo', ok: true, output: 'echo:hi' },
        { name: 'mcp__srv__boom', ok: false, error: 'inner exploded' },
      ],
      logs: 'line one\nline two',
    })
    expect(text).toContain('[1] mcp__srv__echo\necho:hi')
    expect(text).toContain('[2] mcp__srv__boom FAILED\ninner exploded')
    expect(text).toContain('Script output:\nline one\nline two')
  })

  test('tool exposes required metadata', () => {
    expect(RunCodeTool.name).toBe('RunCode')
    expect(RunCodeTool.isConcurrencySafe()).toBe(false)
    expect(RunCodeTool.isEnabled()).toBe(true)
  })
})
