import { describe, expect, test } from 'bun:test'
import {
  type Setting,
  SETTING_CATEGORIES,
  buildSettingsRows,
} from '../../src/components/panels/SettingsDialog/settingsRows.js'

function booleanSetting(
  id: string,
  category: Setting['category'],
  label = id,
): Setting {
  return {
    id,
    category,
    label,
    value: false,
    type: 'boolean',
    onChange() {},
  }
}

describe('buildSettingsRows', () => {
  test('emits a header per category in SETTING_CATEGORIES order', () => {
    // One setting per category, in reverse category order to prove the
    // builder (not input order) drives section order.
    const items = [...SETTING_CATEGORIES]
      .reverse()
      .map(({ id }) => booleanSetting(`id-${id}`, id))
    const rows = buildSettingsRows(items, '')

    const headers = rows.filter(r => r.kind === 'header')
    expect(headers.map(h => (h as { label: string }).label)).toEqual(
      SETTING_CATEGORIES.map(c => c.label),
    )
    // Each header is immediately followed by its category's setting.
    for (const [i, row] of rows.entries()) {
      if (row.kind === 'header') {
        expect(rows[i + 1]).toMatchObject({ kind: 'setting' })
      }
    }
  })

  test('every item lands under exactly one category section', () => {
    const items: Setting[] = [
      ...SETTING_CATEGORIES.flatMap(({ id }) => [
        booleanSetting(`${id}-a`, id),
        booleanSetting(`${id}-b`, id),
      ]),
      // Unmatched input order: later category first.
    ]
    const rows = buildSettingsRows(items, '')
    const settingRows = rows.filter(r => r.kind === 'setting')
    expect(settingRows).toHaveLength(items.length)
    // Each item appears exactly once.
    const ids = settingRows.map(r => (r as { setting: Setting }).setting.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('empty categories are omitted entirely', () => {
    const rows = buildSettingsRows([booleanSetting('theme', 'appearance')], '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Appearance' })
    expect(rows[1]).toMatchObject({ kind: 'setting' })
  })

  test('search keeps only matching settings and their headers', () => {
    const items = [
      booleanSetting('theme', 'appearance', 'Theme'),
      booleanSetting('showTurnDuration', 'appearance', 'Show turn duration'),
      booleanSetting('verbose', 'general', 'Verbose output'),
      booleanSetting('notifChannel', 'notifications', 'Local notifications'),
    ]
    const rows = buildSettingsRows(items, 'theme')

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Appearance' })
    expect(rows[1]).toMatchObject({
      kind: 'setting',
      setting: { id: 'theme' },
    })
  })

  test('search matches fall back to searchText for ReactNode labels', () => {
    const items: Setting[] = [
      {
        id: 'model',
        category: 'modelReasoning',
        label: { type: 'em', key: null, props: { children: 'Model' } },
        searchText: 'Model picker',
        value: 'default',
        type: 'managedEnum',
        onChange() {},
      },
    ]
    const rows = buildSettingsRows(items, 'picker')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ kind: 'setting' })
  })

  test('search with no matches yields no rows', () => {
    const rows = buildSettingsRows(
      [booleanSetting('verbose', 'general', 'Verbose output')],
      'nothing-matches-this',
    )
    expect(rows).toHaveLength(0)
  })

  test('match is case-insensitive on id and label', () => {
    const items = [
      booleanSetting('autoCompactEnabled', 'contextSession', 'Auto-compact'),
    ]
    expect(buildSettingsRows(items, 'AUTOCOMPACT')).toHaveLength(2)
    expect(buildSettingsRows(items, 'auto-compact')).toHaveLength(2)
  })
})
