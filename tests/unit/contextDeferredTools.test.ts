import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tool } from '../../src/Tool.js'

// Force the offline path: API count returns null, so the estimate fallback
// (chars/4) runs deterministically without a provider.
mock.module('../../src/services/tokenEstimation.js', () => ({
  countTokensWithAPI: async (content: string) => (content ? null : 0),
  countMessagesTokensWithAPI: async () => null,
  roughTokenCountEstimation: (content: string, bytesPerToken: number = 4) =>
    Math.round(content.length / bytesPerToken),
  roughTokenCountEstimationForFileType: (content: string) =>
    Math.round(content.length / 4),
  roughTokenCountEstimationForMessages: () => 0,
}))

const { countDeferredToolTokens } =
  await import('../../src/utils/analyzeContext.js')
const { resetSettingsCache } =
  await import('../../src/utils/settings/settingsCache.js')

const previousConfigDir = process.env.FREECODE_CONFIG_DIR

async function useSettings(settings: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'deferred-tools-test-'))
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

function mcpTool(name: string, pad: string): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: name.slice('mcp__srv__'.length) },
    inputJSONSchema: { type: 'object', properties: { q: { type: 'string' } } },
    async prompt() {
      return `description of ${name} ${pad}`
    },
  } as unknown as Tool
}

function builtInTool(name: string): Tool {
  return {
    name,
    isMcp: false,
    inputJSONSchema: { type: 'object', properties: {} },
    async prompt() {
      return `long description of ${name} ${'x'.repeat(4000)}`
    },
  } as unknown as Tool
}

const permCtx = async () => ({})

describe('countDeferredToolTokens', () => {
  test('cataloged MCP and lazy built-ins are counted and grouped', async () => {
    await useSettings({ lazyTools: ['Bash'] })
    const tools = [
      builtInTool('Bash'),
      builtInTool('Read'),
      mcpTool('mcp__srv__search', 'y'.repeat(4000)),
    ]
    const { deferredToolTokens, deferredToolDetails } =
      await countDeferredToolTokens(tools, permCtx, null, 'test-model')
    expect(deferredToolTokens).toBeGreaterThan(0)
    expect(deferredToolDetails.map(d => d.name).sort()).toEqual([
      'Bash',
      'mcp__srv__search',
    ])
    expect(deferredToolDetails.find(d => d.name === 'Bash')?.group).toBe(
      'built-ins',
    )
    expect(
      deferredToolDetails.find(d => d.name === 'mcp__srv__search')?.group,
    ).toBe('srv')
    const total = deferredToolDetails.reduce((s, d) => s + d.tokens, 0)
    expect(total).toBeGreaterThan(0)
  })

  test('kill switch reports nothing deferred', async () => {
    await useSettings({
      lazyTools: ['Bash'],
      disableMcpToolCatalog: true,
    })
    const tools = [builtInTool('Bash'), mcpTool('mcp__srv__search', 'y')]
    const { deferredToolTokens, deferredToolDetails } =
      await countDeferredToolTokens(tools, permCtx, null, 'test-model')
    expect(deferredToolTokens).toBe(0)
    expect(deferredToolDetails).toEqual([])
  })

  test('exposed-only tool list reports nothing deferred', async () => {
    await useSettings({})
    const { deferredToolTokens } = await countDeferredToolTokens(
      [builtInTool('Read')],
      permCtx,
      null,
      'test-model',
    )
    expect(deferredToolTokens).toBe(0)
  })
})
