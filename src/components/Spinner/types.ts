/** RGB color as individual numeric components. */
export type RGBColor = { r: number; g: number; b: number }

/**
 * Mode for the streaming indicator spinner. Drives shimmer speed, glyph
 * selection, and accompanying copy. Enumerated from every
 * `setStreamMode(...)` call site and every `case` in
 * src/components/Spinner/SpinnerAnimationRow.tsx.
 */
export type SpinnerMode =
  | 'responding'
  | 'thinking'
  | 'requesting'
  | 'tool-use'
  | 'tool-input'
