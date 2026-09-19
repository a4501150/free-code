import { env } from '../utils/env.js'

// The former is better vertically aligned, but isn't usually supported on Windows/Linux
export const BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
export const BULLET_OPERATOR = '∙'
export const TEARDROP_ASTERISK = '✻'
export const UP_ARROW = '\u2191' // ↑ - used for opus 1m merge notice
export const DOWN_ARROW = '\u2193' // ↓ - used for scroll hint
export const LIGHTNING_BOLT = '»' // U+00BB guillemet - fast mode indicator (U+21AF has poor font coverage)
export const EFFORT_LOW = '○' // \u25cb - effort level: low
export const EFFORT_MEDIUM = '◐' // \u25d0 - effort level: medium
export const EFFORT_HIGH = '●' // \u25cf - effort level: high
export const EFFORT_MAX = '◉' // \u25c9 - effort level: max
export const EFFORT_XHIGH = '◍' // \u25cd - effort level: xhigh (OpenAI models)

// Media/trigger status indicators. Single-column ASCII to match the
// one-glyph-per-segment statusline style (U+23F8/U+23F5 have emoji
// presentation and render badly in Windows terminals).
export const PAUSE_ICON = '|'
export const FF_ICON = '>' // fast-forward — auto-accept mode and running-agent indicator

// MCP subscription indicators
export const REFRESH_ARROW = '\u21bb' // ↻ - used for resource update indicator
export const CHANNEL_ARROW = '\u2190' // ← - inbound channel message indicator
export const INJECTED_ARROW = '\u2192' // → - cross-session injected message indicator
// Review status indicators (ultrareview diamond states)
export const DIAMOND_OPEN = '\u25c7' // ◇ - running
export const DIAMOND_FILLED = '\u25c6' // ◆ - completed/failed
export const REFERENCE_MARK = '*' // away-summary recap marker (U+203B needs a CJK font)

// Blockquote indicator
export const BLOCKQUOTE_BAR = '\u258e' // ▎ - left one-quarter block, used as blockquote line prefix
export const HEAVY_HORIZONTAL = '\u2501' // ━ - heavy box-drawing horizontal

// Disclosure triangles for a row whose body expands in place
export const DISCLOSURE_COLLAPSED = '\u25b8' // ▸
export const DISCLOSURE_EXPANDED = '\u25be' // ▾
