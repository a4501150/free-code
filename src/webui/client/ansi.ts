/**
 * Minimal ANSI text renderer for the shell output panes.
 *
 * Non-interactive task output keeps the colors compilers and build tools
 * emit (the TUI renders them through ink; the browser needs them as spans).
 * Everything that is not SGR — cursor moves, clears, OSC titles — is
 * stripped, and control characters are folded to newlines, so the pane can
 * never paint escape noise.
 *
 * The parser is pure data (no React) so it is unit-testable in bun, and it
 * tolerates a sequence cut in half by a streaming append: the unterminated
 * tail is simply not emitted and reappears complete on the next parse.
 */

export type AnsiStyle = {
  color?: string
  background?: string
  bold?: boolean
  dim?: boolean
  underline?: boolean
  inverse?: boolean
}

export type AnsiSegment = {
  text: string
  style?: AnsiStyle
}

const BASE16 = [
  '#2e3436',
  '#c01c28',
  '#26a269',
  '#a2734c',
  '#12488b',
  '#a347ba',
  '#2aa1b3',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#26d26e',
  '#c4a000',
  '#3465a4',
  '#c06bde',
  '#33c7c7',
  '#eeeeec',
]

/** xterm 256-color cube + grayscale ramp, computed rather than tabled. */
function color256(n: number): string {
  if (n < 16) return BASE16[n]!
  if (n < 232) {
    const v = n - 16
    const level = (c: number): string =>
      c === 0 ? '00' : (c * 40 + 55).toString(16)
    return `#${level(Math.floor(v / 36))}${level(Math.floor(v / 6) % 6)}${level(v % 6)}`
  }
  const g = (n - 232) * 10 + 8
  const hex = g.toString(16).padStart(2, '0')
  return `#${hex}${hex}${hex}`
}

function truecolor(
  params: number[],
  from: number,
): { css: string; used: number } | null {
  if (params[from] === 2 && params.length >= from + 4) {
    const [r, g, b] = [params[from + 1]!, params[from + 2]!, params[from + 3]!]
    return {
      css: `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`,
      used: 4,
    }
  }
  if (params[from] === 5 && params.length >= from + 2) {
    return { css: color256(Math.min(255, params[from + 1]!)), used: 2 }
  }
  return null
}

function applySgr(codes: number[], style: AnsiStyle): AnsiStyle {
  let next = style
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!
    if (c === 0) next = {}
    else if (c === 1) next = { ...next, bold: true }
    else if (c === 2) next = { ...next, dim: true }
    else if (c === 4) next = { ...next, underline: true }
    else if (c === 7) next = { ...next, inverse: true }
    else if (c === 22) next = { ...next, bold: false, dim: false }
    else if (c === 24) next = { ...next, underline: false }
    else if (c === 27) next = { ...next, inverse: false }
    else if (c === 39) next = { ...next, color: undefined }
    else if (c === 49) next = { ...next, background: undefined }
    else if (c >= 30 && c <= 37) next = { ...next, color: BASE16[c - 30] }
    else if (c >= 40 && c <= 47) next = { ...next, background: BASE16[c - 40] }
    else if (c >= 90 && c <= 97) next = { ...next, color: BASE16[c - 90 + 8] }
    else if (c >= 100 && c <= 107)
      next = { ...next, background: BASE16[c - 100 + 8] }
    else if (c === 38 || c === 48) {
      const got = truecolor(codes, i + 1)
      if (got) {
        next =
          c === 38
            ? { ...next, color: got.css }
            : { ...next, background: got.css }
        i += got.used
      } else {
        // A half-consumed extended color makes the rest of the list
        // uninterpretable: stop applying rather than paint random codes.
        break
      }
    }
  }
  return next
}

/**
 * Split raw terminal text into styled segments. An unterminated escape at
 * the very end (a stream cut mid-sequence) yields no segment for the
 * fragment — the next append completes it and a re-parse picks it up.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = []
  let style: AnsiStyle = {}
  let plain = ''
  let i = 0
  const flush = (): void => {
    if (plain) {
      out.push(
        style.color ||
          style.background ||
          style.bold ||
          style.dim ||
          style.underline ||
          style.inverse
          ? { text: plain, style }
          : { text: plain },
      )
      plain = ''
    }
  }
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\x1b') {
      const next = text[i + 1]
      if (next === '[') {
        // CSI parameters run to 0x30-0x3F; the final byte is 0x40-0x7E.
        let j = i + 2
        while (j < text.length && text.charCodeAt(j) < 0x40) j++
        const final = text[j]
        if (final === undefined) break // unterminated at EOS
        if (final === 'm') {
          const params = text
            .slice(i + 2, j)
            .split(/[;:]/)
            .map(p => (p === '' ? 0 : parseInt(p, 10)))
            .filter(n => Number.isFinite(n))
          flush()
          style = applySgr(params, style)
        }
        i = j + 1
        continue
      }
      if (next === ']') {
        // OSC: terminated by BEL or ST (ESC \).
        const bel = text.indexOf('\x07', i)
        const st = text.indexOf('\x1b\\', i)
        const stop = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        if (stop === -1) break
        i = bel === stop ? stop + 1 : stop + 2
        continue
      }
      if (next === undefined) break
      // Charset selects are three bytes (ESC ( B); consuming two leaks the
      // final byte into the text and shreds whatever sequence follows.
      i += next === '(' || next === ')' || next === '#' || next === '%' ? 3 : 2
      continue
    }
    if (ch === '\r') {
      plain += '\n'
      i += text[i + 1] === '\n' ? 2 : 1
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20 && ch !== '\n' && ch !== '\t') {
      i++
      continue
    }
    plain += ch
    i++
  }
  flush()
  return out
}
