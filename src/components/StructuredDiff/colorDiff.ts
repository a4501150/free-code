import {
  ColorDiff,
  ColorFile,
  getSyntaxTheme as nativeGetSyntaxTheme,
  type SyntaxTheme,
} from '../../native-ts/color-diff/index.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export type ColorModuleUnavailableReason = 'settings'

/**
 * Returns a static reason why the color-diff module is unavailable, or null if available.
 * 'settings' = disabled via syntaxHighlightingDisabled in settings.
 */
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (getInitialSettings()?.syntaxHighlightingDisabled === true) {
    return 'settings'
  }
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  return getColorModuleUnavailableReason() === null ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  return getColorModuleUnavailableReason() === null ? ColorFile : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? nativeGetSyntaxTheme(themeName)
    : null
}
