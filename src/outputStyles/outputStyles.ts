import memoize from 'lodash-es/memoize.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { loadMarkdownFilesForSubdir } from '../utils/markdownConfigLoader.js'
import { loadPluginOutputStyles } from '../utils/plugins/loadPluginOutputStyles.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../utils/settings/constants.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'
import { getOutputStyleDirStyles } from './loadOutputStylesDir.js'
import { SIMPLE_ENGLISH_PROMPT } from './simpleEnglish.js'

export type OutputStyleSource = SettingSource | 'built-in' | 'plugin'

export type OutputStyleConfig = {
  name: string
  description: string
  prompt: string
  source: OutputStyleSource
  /** Keep the `# Doing tasks` and `# Code style` prompt sections. */
  keepCodingInstructions: boolean
  /** Keep the `# Response style` prompt section. */
  keepResponseStyle: boolean
  /** Plugin styles only: apply this style regardless of the settings key. */
  forceForPlugin?: boolean
}

/** Selects no style at all: the system prompt as if the feature did not exist. */
export const NO_OUTPUT_STYLE_NAME = 'none'

/** Used when the setting is absent or set to `default`. */
export const DEFAULT_OUTPUT_STYLE_NAME = 'simple-english'

/** Names a custom or plugin style may not claim. */
export const RESERVED_OUTPUT_STYLE_NAMES = new Set([
  NO_OUTPUT_STYLE_NAME,
  'default',
])

export const BUILT_IN_OUTPUT_STYLES: {
  readonly [name: string]: OutputStyleConfig | null
} = {
  [NO_OUTPUT_STYLE_NAME]: null,
  [DEFAULT_OUTPUT_STYLE_NAME]: {
    name: DEFAULT_OUTPUT_STYLE_NAME,
    description: 'Write prose in ASD-STE100 Simplified Technical English',
    prompt: SIMPLE_ENGLISH_PROMPT,
    source: 'built-in',
    keepCodingInstructions: true,
    keepResponseStyle: true,
  },
}

/**
 * Every style available for selection, keyed by name. Merged lowest to highest
 * precedence: built-in, plugin, user, project.
 */
export const getAllOutputStyles = memoize(
  async (
    cwd: string,
  ): Promise<{ [name: string]: OutputStyleConfig | null }> => {
    const [dirStyles, pluginStyles] = await Promise.all([
      getOutputStyleDirStyles(cwd),
      loadPluginOutputStyles(),
    ])

    const allStyles: { [name: string]: OutputStyleConfig | null } = {
      ...BUILT_IN_OUTPUT_STYLES,
    }

    const groups = [
      pluginStyles,
      dirStyles.filter(style => style.source === 'userSettings'),
      dirStyles.filter(style => style.source !== 'userSettings'),
    ]
    for (const group of groups) {
      for (const style of group) {
        allStyles[style.name] = style
      }
    }

    return allStyles
  },
)

/** Resolve the settings value to a style name, applying the `default` alias. */
export function resolveOutputStyleName(setting: string | undefined): string {
  const requested = setting?.trim()
  if (!requested || requested === 'default') return DEFAULT_OUTPUT_STYLE_NAME
  return requested
}

function getForcedPluginStyle(styles: {
  [name: string]: OutputStyleConfig | null
}): OutputStyleConfig | null {
  const forced = Object.values(styles)
    .filter(
      (style): style is OutputStyleConfig =>
        style !== null &&
        style.source === 'plugin' &&
        style.forceForPlugin === true,
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  const winner = forced[0]
  if (!winner) return null
  if (forced.length > 1) {
    logForDebugging(
      `Multiple plugins force an output style: ${forced.map(_ => _.name).join(', ')}. Using ${winner.name}`,
      { level: 'warn' },
    )
  }
  return winner
}

/**
 * Resolve a settings value against the catalogue. An unrecognized name behaves
 * as if the setting were absent; only `none` disables styling.
 */
export async function resolveOutputStyle(
  cwd: string,
  setting: string | undefined,
): Promise<OutputStyleConfig | null> {
  const allStyles = await getAllOutputStyles(cwd)

  const forced = getForcedPluginStyle(allStyles)
  if (forced) return forced

  const name = resolveOutputStyleName(setting)
  if (name === NO_OUTPUT_STYLE_NAME) return null

  const style = allStyles[name]
  if (style === undefined) {
    logForDebugging(
      `Unknown output style "${name}" — using ${DEFAULT_OUTPUT_STYLE_NAME}`,
      { level: 'warn' },
    )
    return allStyles[DEFAULT_OUTPUT_STYLE_NAME] ?? null
  }
  return style
}

/**
 * Why a style written to user settings will not be the one that applies:
 * a plugin forces its own, or a higher-precedence settings source disagrees.
 */
export async function getOutputStyleOverrideNotice(
  chosenName: string,
): Promise<string | null> {
  const forced = getForcedPluginStyle(await getAllOutputStyles(getCwd()))
  if (forced && forced.name !== chosenName) {
    return `A plugin forces the "${forced.name}" output style, which overrides this setting.`
  }

  for (const source of [
    'flagSettings',
    'localSettings',
    'projectSettings',
  ] as const) {
    const configured = getSettingsForSource(source)?.outputStyle
    if (configured !== undefined && configured !== chosenName) {
      return `Your ${getSettingSourceName(source)} settings set "${configured}", which takes precedence.`
    }
  }

  return null
}

// The active style is a snapshot: a settings edit or a picker selection must not
// rewrite the running conversation's cached prompt prefix. Re-resolved only by
// /clear, which starts a fresh conversation anyway.
let activeStylePromise: Promise<OutputStyleConfig | null> | null = null
let resolvedActiveStyle: OutputStyleConfig | null = null
let hasResolvedActiveStyle = false

export function getActiveOutputStyle(): Promise<OutputStyleConfig | null> {
  if (!activeStylePromise) {
    activeStylePromise = resolveOutputStyle(
      getCwd(),
      getInitialSettings().outputStyle,
    ).then(style => {
      resolvedActiveStyle = style
      hasResolvedActiveStyle = true
      return style
    })
  }
  return activeStylePromise
}

/**
 * The active style's name for synchronous consumers (statusline, init message).
 * Falls back to the alias-resolved settings value before the snapshot resolves,
 * which can name a style the catalogue does not have.
 */
export function getActiveOutputStyleNameSync(): string {
  if (hasResolvedActiveStyle) {
    return resolvedActiveStyle?.name ?? NO_OUTPUT_STYLE_NAME
  }
  return resolveOutputStyleName(getInitialSettings().outputStyle)
}

export function clearOutputStyleCaches(): void {
  getAllOutputStyles.cache?.clear?.()
  getOutputStyleDirStyles.cache?.clear?.()
  // Shared with commands, agents and skills, and cleared by their clears too.
  // Repeat it here so a style added on disk is picked up even if the order or
  // membership of those clears changes.
  loadMarkdownFilesForSubdir.cache?.clear?.()
}

/** Re-resolve the active style. Called on /clear, never mid-conversation. */
export function resetActiveOutputStyle(): void {
  activeStylePromise = null
  resolvedActiveStyle = null
  hasResolvedActiveStyle = false
}
