/**
 * Parse a human duration string into milliseconds for the Monitor tool's
 * notify_interval parameter. Single-unit only (e.g. "90s", "5m",
 * "1h", "1.5h"). Fails fast on anything else — an unparseable value must
 * error, never silently fall back to a default (dead-flag trap).
 */
const NOTIFY_INTERVAL_RE = /^(\d+(?:\.\d+)?)([smh])$/

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
}

/** Parse a notify-frequency string to milliseconds, or undefined when
 *  invalid. Valid forms: `<number>[s|m|h]` with an optional decimal point;
 *  the number must be > 0. */
export function parseNotifyIntervalMs(value: string): number | undefined {
  const match = NOTIFY_INTERVAL_RE.exec(value.trim())
  if (!match) return undefined
  const ms = Number.parseFloat(match[1]!) * UNIT_MS[match[2]!]!
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return ms
}

/** Human-readable description of the accepted forms, for error messages. */
export const NOTIFY_INTERVAL_FORMATS =
  'a positive number followed by s, m, or h (e.g. "90s", "5m", "1h")'

/** Ready-to-render rejection message for an unparseable value. Single
 *  construction site: validateInput and the defensive call-path throw must
 *  produce the same text. */
export function notifyIntervalError(value: string | undefined): string {
  return `Invalid notify_interval "${value}": expected ${NOTIFY_INTERVAL_FORMATS}.`
}
