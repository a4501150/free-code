import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import type { Tool } from '../../src/Tool.js'
import { InvokeTool } from '../../src/tools/InvokeToolTool/InvokeToolTool.js'
import { AssistantToolUseMessage } from '../../src/components/messages/AssistantToolUseMessage.js'
import { renderToString } from '../../src/utils/staticRender.js'
import { AppStateProvider } from '../../src/state/AppState.js'

const { resetSettingsCache } =
  await import('../../src/utils/settings/settingsCache.js')

const previousConfigDir = process.env.FREECODE_CONFIG_DIR

async function useSettings(settings: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'invoke-card-test-'))
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

function mcpInnerTool(name: string, facingName: string): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: facingName },
    inputSchema: z.object({ q: z.string() }),
    userFacingName: () => facingName,
  } as unknown as Tool
}

function invokeCard(input: Record<string, unknown>) {
  return (
    <AppStateProvider>
      <AssistantToolUseMessage
        param={
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'InvokeTool',
            input,
          } as never
        }
        addMargin={false}
        tools={[InvokeTool, mcpInnerTool('mcp__srv__search', 'web_search')]}
        verbose={false}
        inProgressToolUseIDs={new Set(['tu1'])}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={false}
        lookups={
          {
            resolvedToolUseIDs: new Set(),
            erroredToolUseIDs: new Set(),
          } as never
        }
      />
    </AppStateProvider>
  )
}

describe('InvokeTool card display', () => {
  test('renders the inner tool card for a valid dispatch', async () => {
    await useSettings({})
    const frame = await renderToString(
      invokeCard({ tool: 'mcp__srv__search', args: { q: 'hello world' } }),
    )
    expect(frame).toContain('(Invoke) web_search')
    expect(frame).toContain('hello world')
    expect(frame).not.toContain('"args"')
  })

  test('falls back to the raw dispatcher card for an unknown tool', async () => {
    await useSettings({})
    const frame = await renderToString(
      invokeCard({ tool: 'mcp__srv__typo', args: { q: 'hi' } }),
    )
    expect(frame).toContain('InvokeTool')
    expect(frame).not.toContain('(Invoke) ')
  })

  test('falls back to the raw dispatcher card for unparseable args', async () => {
    await useSettings({})
    const frame = await renderToString(
      invokeCard({ tool: 'mcp__srv__search', args: { wrong: 1 } }),
    )
    expect(frame).toContain('InvokeTool')
    expect(frame).not.toContain('(Invoke) ')
  })
})
