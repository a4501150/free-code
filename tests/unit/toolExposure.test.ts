import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  INVOKE_TOOL_NAME,
  isToolExposedToModel,
} from '../../src/services/toolCatalog/exposure.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'

const previousConfigDir = process.env.FREECODE_CONFIG_DIR

async function useSettings(settings: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'tool-exposure-test-'))
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

describe('tool exposure', () => {
  test('default: built-ins exposed, MCP cataloged', async () => {
    await useSettings({})
    expect(isToolExposedToModel({ name: 'Bash', isMcp: false })).toBe(true)
    expect(isToolExposedToModel({ name: 'mcp__srv__a', isMcp: true })).toBe(
      false,
    )
  })

  test('lazyTools hides named built-ins but never the dispatcher', async () => {
    await useSettings({ lazyTools: ['Bash', INVOKE_TOOL_NAME] })
    expect(isToolExposedToModel({ name: 'Bash', isMcp: false })).toBe(false)
    expect(isToolExposedToModel({ name: 'Read', isMcp: false })).toBe(true)
    expect(isToolExposedToModel({ name: INVOKE_TOOL_NAME, isMcp: false })).toBe(
      true,
    )
  })

  test('disableMcpToolCatalog exposes everything again', async () => {
    await useSettings({
      lazyTools: ['Bash'],
      disableMcpToolCatalog: true,
    })
    expect(isToolExposedToModel({ name: 'Bash', isMcp: false })).toBe(true)
    expect(isToolExposedToModel({ name: 'mcp__srv__a', isMcp: true })).toBe(
      true,
    )
  })
})
