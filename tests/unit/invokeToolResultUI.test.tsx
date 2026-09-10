import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import type { Tool } from '../../src/Tool.js'
import { InvokeTool } from '../../src/tools/InvokeToolTool/InvokeToolTool.js'
import { renderToolUseProgressMessage as mcpRenderProgress } from '../../src/tools/MCPTool/UI.js'
import { UserToolSuccessMessage } from '../../src/components/messages/UserToolResultMessage/UserToolSuccessMessage.js'
import { UserToolErrorMessage } from '../../src/components/messages/UserToolResultMessage/UserToolErrorMessage.js'
import { renderToString } from '../../src/utils/staticRender.js'
import { AppStateProvider } from '../../src/state/AppState.js'

const { resetSettingsCache } =
  await import('../../src/utils/settings/settingsCache.js')

const previousConfigDir = process.env.FREECODE_CONFIG_DIR

async function useSettings(settings: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'invoke-result-test-'))
  await writeFile(join(dir, 'freecode.json'), JSON.stringify(settings))
  process.env.FREECODE_CONFIG_DIR = dir
  resetSettingsCache()
}

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.FREECODE_CONFIG_DIR
  } else {
    process.env.FREECODE_CONFIG_DIR = previousConfigDir
  }
  resetSettingsCache()
})

function mcpInnerTool(
  name: string,
  facingName: string,
  extra: Partial<Tool> = {},
): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: facingName },
    inputSchema: z.object({}).passthrough(),
    userFacingName: () => facingName,
    ...extra,
  } as unknown as Tool
}

const OUTER_INPUT = {
  tool: 'mcp__srv__search',
  args: { q: 'hello world' },
}

function lookupsWithOuterInput(): never {
  return {
    resolvedToolUseIDs: new Set(),
    erroredToolUseIDs: new Set(),
    toolUseByToolUseID: new Map([
      ['tu1', { id: 'tu1', name: 'InvokeTool', input: OUTER_INPUT }],
    ]),
  } as never
}

describe('InvokeTool result rendering', () => {
  test('fallback renders string output when the inner tool has no renderer', async () => {
    await useSettings({})
    const inner = mcpInnerTool('mcp__srv__search', 'web_search')
    const node = InvokeTool.renderToolResultMessage!(
      '{"ok":true,"count":2}',
      [],
      { verbose: true, tools: [InvokeTool, inner], input: OUTER_INPUT },
    )
    const frame = await renderToString(
      <AppStateProvider>{node}</AppStateProvider>,
    )
    expect(frame).toContain('"ok"')
    expect(frame).toContain('true')
  })

  test('fallback renders content arrays, images as [Image]', async () => {
    await useSettings({})
    const inner = mcpInnerTool('mcp__srv__search', 'web_search')
    const node = InvokeTool.renderToolResultMessage!(
      [
        { type: 'text', text: 'found 3 results' },
        { type: 'image', source: { data: 'AAA', media_type: 'image/png' } },
      ],
      [],
      { verbose: true, tools: [InvokeTool, inner], input: OUTER_INPUT },
    )
    const frame = await renderToString(
      <AppStateProvider>{node}</AppStateProvider>,
    )
    expect(frame).toContain('found 3 results')
    expect(frame).toContain('[Image]')
  })

  test('success pipeline delegates to the inner tool renderer with inner args', async () => {
    await useSettings({})
    let seenInput: unknown
    const inner = mcpInnerTool('mcp__srv__search', 'web_search', {
      renderToolResultMessage(
        content: unknown,
        _progress: unknown,
        options: { input?: unknown },
      ) {
        seenInput = options.input
        return `INNER:${String(content)}`
      },
    })
    const frame = await renderToString(
      <AppStateProvider>
        <UserToolSuccessMessage
          message={
            {
              type: 'user',
              uuid: 'u1',
              toolUseResult: '{"ok":true}',
            } as never
          }
          lookups={lookupsWithOuterInput()}
          toolUseID="tu1"
          progressMessagesForMessage={[]}
          tool={InvokeTool}
          tools={[InvokeTool, inner]}
          verbose={false}
          width={80}
        />
      </AppStateProvider>,
    )
    expect(frame).toContain('INNER:')
    expect(seenInput).toEqual({ q: 'hello world' })
  })

  test('error rendering names the inner tool and its args', async () => {
    await useSettings({})
    const inner = mcpInnerTool('mcp__srv__search', 'web_search')
    const frame = await renderToString(
      <AppStateProvider>
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tool={InvokeTool}
          tools={[InvokeTool, inner]}
          param={
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: 'Error: inner tool exploded',
              is_error: true,
            } as never
          }
          input={OUTER_INPUT}
          verbose={true}
        />
      </AppStateProvider>,
    )
    expect(frame).toContain('(Invoke) web_search')
    expect(frame).toContain('{"q":"hello world"}')
    expect(frame).toContain('inner tool exploded')
  })

  test('error rendering names an unresolved target by its raw name', async () => {
    await useSettings({})
    const frame = await renderToString(
      <AppStateProvider>
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tool={InvokeTool}
          tools={[InvokeTool]}
          param={
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: 'Unknown tool "mcp__srv__typo".',
              is_error: true,
            } as never
          }
          input={{ tool: 'mcp__srv__typo', args: { q: 'hi' } }}
          verbose={true}
        />
      </AppStateProvider>,
    )
    expect(frame).toContain('(Invoke) mcp__srv__typo')
    expect(frame).toContain('Unknown tool')
  })

  test('in-progress pipeline delegates to the inner tool progress renderer', async () => {
    await useSettings({})
    const inner = mcpInnerTool('mcp__srv__search', 'web_search', {
      renderToolUseProgressMessage: mcpRenderProgress,
    })
    const { AssistantToolUseMessage } =
      await import('../../src/components/messages/AssistantToolUseMessage.js')
    const frame = await renderToString(
      <AppStateProvider>
        <AssistantToolUseMessage
          param={
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'InvokeTool',
              input: OUTER_INPUT,
            } as never
          }
          addMargin={false}
          tools={[InvokeTool, inner]}
          verbose={false}
          inProgressToolUseIDs={new Set(['tu1'])}
          progressMessagesForMessage={[
            {
              type: 'progress',
              toolUseID: 'tu1',
              parentToolUseID: 'tu1',
              data: { type: 'mcp_progress' },
            } as never,
          ]}
          shouldAnimate={false}
          shouldShowDot={false}
          lookups={
            {
              resolvedToolUseIDs: new Set(),
              erroredToolUseIDs: new Set(),
            } as never
          }
        />
      </AppStateProvider>,
    )
    expect(frame).toContain('(Invoke) web_search')
    expect(frame).toContain('Running…')
  })
})
