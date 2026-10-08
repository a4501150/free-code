/**
 * Pure row model for the settings Config tab: category-tagged settings
 * grouped into section rows (header + settings), with no component or
 * store imports so the grouping logic is unit-testable standalone.
 */
import type { ReactNode } from 'react'

export type SettingCategory =
  | 'general'
  | 'appearance'
  | 'modelReasoning'
  | 'contextSession'
  | 'permissionsSafety'
  | 'inputFiles'
  | 'notifications'
  | 'integrations'
  | 'advanced'

/** Display order and titles of the config-tab sections. */
export const SETTING_CATEGORIES: ReadonlyArray<{
  id: SettingCategory
  label: string
}> = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'modelReasoning', label: 'Model & reasoning' },
  { id: 'contextSession', label: 'Context & session' },
  { id: 'permissionsSafety', label: 'Permissions & safety' },
  { id: 'inputFiles', label: 'Input & files' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'advanced', label: 'Advanced' },
]

type SettingBase = {
  category: SettingCategory
} & (
  | {
      id: string
      label: string
    }
  | {
      id: string
      label: ReactNode
      searchText: string
    }
)

export type Setting =
  | (SettingBase & {
      value: boolean
      onChange(value: boolean): void
      type: 'boolean'
    })
  | (SettingBase & {
      value: string
      options: string[]
      onChange(value: string): void
      type: 'enum'
    })
  | (SettingBase & {
      // For enums that are set by a custom component, we don't need to pass options,
      // but we still need a value to display in the top-level config menu
      value: string
      onChange(value: string): void
      type: 'managedEnum'
    })

export type SettingsRow =
  | { kind: 'header'; id: string; label: string }
  | { kind: 'setting'; setting: Setting }

/**
 * Group settings into section rows: a non-selectable header row per
 * category (in SETTING_CATEGORIES order) followed by that category's
 * settings. With a search query, only matching settings are kept and a
 * header is emitted only when at least one of its settings matches.
 */
export function buildSettingsRows(
  items: Setting[],
  query: string,
): SettingsRow[] {
  const lowerQuery = query.toLowerCase()
  const matches = (setting: Setting): boolean => {
    if (setting.id.toLowerCase().includes(lowerQuery)) return true
    const searchableText =
      'searchText' in setting ? setting.searchText : setting.label
    return searchableText.toLowerCase().includes(lowerQuery)
  }

  const rows: SettingsRow[] = []
  for (const category of SETTING_CATEGORIES) {
    const settings = items.filter(
      setting =>
        setting.category === category.id && (query === '' || matches(setting)),
    )
    if (settings.length === 0) continue
    rows.push({
      kind: 'header',
      id: `header-${category.id}`,
      label: category.label,
    })
    for (const setting of settings) {
      rows.push({ kind: 'setting', setting })
    }
  }
  return rows
}
