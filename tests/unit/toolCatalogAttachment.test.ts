import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Attachment, Message } from '../../src/types/message.js'

const { getToolCatalogAttachment } =
  await import('../../src/utils/attachments.js')
const { resetSettingsCache } =
  await import('../../src/utils/settings/settingsCache.js')

const previousConfigDir = process.env.FREECODE_CONFIG_DIR

async function useSettings(settings: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'tool-catalog-att-test-'))
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

function attachMessage(attachment: Attachment): Message {
  return {
    type: 'attachment',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    attachment,
  } as Message
}

describe('tool_catalog attachment', () => {
  test('announces the full pointer when the transcript has no prior row', () => {
    const atts = getToolCatalogAttachment(undefined)
    expect(atts).toHaveLength(1)
    expect(atts[0]).toMatchObject({ type: 'tool_catalog' })
    // The project-scope flag reflects this machine's config, not a fixed
    // value — assert it is carried, not its value.
    expect(
      typeof (atts[0] as { hasProjectScope: unknown }).hasProjectScope,
    ).toBe('boolean')
    expect(getToolCatalogAttachment([])).toHaveLength(1)
  })

  test('a prior row with the same flag silences it', () => {
    // Build the prior row from the emitter's own current flag so the
    // assertion does not depend on this machine's project configs.
    const current = getToolCatalogAttachment(undefined)[0] as {
      hasProjectScope: boolean
    }
    const prior = attachMessage({
      type: 'tool_catalog',
      hasProjectScope: current.hasProjectScope,
    })
    expect(getToolCatalogAttachment([prior])).toEqual([])
    // A different carrier's row is not a prior row.
    const other = attachMessage({
      type: 'deferred_tools_delta',
      generation: 1,
      builtins: [],
      builtinsAdded: [],
      builtinsRemoved: [],
    })
    expect(getToolCatalogAttachment([other])).toHaveLength(1)
  })

  test('a flag flip re-announces the pointer', () => {
    const current = getToolCatalogAttachment(undefined)[0] as {
      hasProjectScope: boolean
    }
    const stale = attachMessage({
      type: 'tool_catalog',
      hasProjectScope: !current.hasProjectScope,
    })
    const atts = getToolCatalogAttachment([stale])
    expect(atts).toHaveLength(1)
    expect(atts[0]).toMatchObject({
      type: 'tool_catalog',
      hasProjectScope: current.hasProjectScope,
    })
  })

  test('the kill switch reports no catalog', async () => {
    await useSettings({ disableMcpToolCatalog: true })
    expect(getToolCatalogAttachment(undefined)).toEqual([])
  })
})
