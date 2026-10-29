import katex from 'katex'
import { color } from '../components/design-system/color.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { ThemeName } from './theme.js'

/**
 * Tier-3 terminal typesetting for display math: KaTeX's parser produces the
 * AST (we never touch its HTML/domTree path), and this module composes the
 * AST into a character grid of uniformly-sized lines.
 *
 * Every node renders to a `GlyphBox { lines, width, baseline }` where
 * `baseline` is the row index of the box's math axis. Horizontal sequences
 * (`hcat`) paste boxes onto a cell `Canvas` aligned on a shared baseline
 * row; vertical constructs (fractions, limits, accents, scripts) paste
 * boxes at (x, y) and hand the result back as another GlyphBox. The entry
 * point returns the grid as one ANSI string (single theme color, the role
 * codespan already gives inline math), or `null` on any failure or width
 * overflow so the caller falls back to the dim rail.
 */

// ---------------------------------------------------------------------------
// KaTeX parser surface (semi-internal `__parse`; the exact version pin is
// the blast radius — AST nodes are `{type, ...}` plain objects).
// ---------------------------------------------------------------------------

interface Dim {
  number: number
  unit: string
}

interface Nd {
  type: string
  [key: string]: unknown
}

type ParseFn = (tex: string, settings: object) => Nd[]

const parse = (katex as unknown as { __parse?: ParseFn }).__parse as
  | ParseFn
  | undefined

// ---------------------------------------------------------------------------
// GlyphBox + canvas
// ---------------------------------------------------------------------------

interface GlyphBox {
  /** Rows, each exactly `width` cells wide (padded). Plain text, no ANSI. */
  lines: string[]
  width: number
  /** Row index of the math axis. */
  baseline: number
}

/** First visible cell of a string (surrogate-pair safe). */
function firstCell(s: string): string {
  return [...s][0] ?? ' '
}

function padTo(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - stringWidth(s)))
}

function glyphBox(text: string, baseline = 0): GlyphBox {
  if (text === '') return { lines: [''], width: 0, baseline: 0 }
  const width = stringWidth(text)
  return { lines: [padTo(text, width)], width, baseline }
}

const EMPTY: GlyphBox = { lines: [''], width: 0, baseline: 0 }

/** Mutable cell canvas: `height` rows of exactly `width` single cells. */
class Canvas {
  rows: string[][]

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rows = Array.from({ length: height }, () =>
      Array<string>(width).fill(' '),
    )
  }

  /** Paste `box` with its baseline on row `baselineRow`, left edge at x. */
  place(box: GlyphBox, x: number, baselineRow: number): void {
    const top = baselineRow - box.baseline
    for (let i = 0; i < box.lines.length; i++) {
      const row = this.rows[top + i]
      if (!row) continue
      let col = x
      for (const cell of box.lines[i]!) {
        if (col >= 0 && col < this.width) row[col] = firstCell(cell)
        col++
      }
    }
  }

  /** Fill row `r` columns [x, x+n) with `ch`. */
  hline(r: number, x: number, n: number, ch: string): void {
    const row = this.rows[r]
    if (!row) return
    for (let c = x; c < Math.min(x + n, this.width); c++) row[c] = ch
  }

  box(baseline: number): GlyphBox {
    return {
      lines: this.rows.map(r => r.join('')),
      width: this.width,
      baseline,
    }
  }
}

/** Paste boxes left-to-right, aligning baselines on a shared row. */
function hcat(boxes: GlyphBox[]): GlyphBox {
  const kept = boxes.filter(b => b.width > 0)
  if (kept.length === 0) return EMPTY
  const width = kept.reduce((s, b) => s + b.width, 0)
  const baseline = kept.reduce((m, b) => Math.max(m, b.baseline), 0)
  if (kept.length === 1 && baseline === kept[0]!.baseline) return kept[0]!
  const height = kept.reduce(
    (m, b) => Math.max(m, baseline - b.baseline + b.lines.length),
    1,
  )
  const cv = new Canvas(width, height)
  let x = 0
  for (const b of kept) {
    cv.place(b, x, baseline)
    x += b.width
  }
  return cv.box(baseline)
}

/** Center `box` horizontally within a fresh canvas of `width` columns. */
function centerIn(box: GlyphBox, width: number): GlyphBox {
  if (box.width === width) return box
  const cv = new Canvas(width, box.lines.length)
  cv.place(box, Math.floor((width - box.width) / 2), box.baseline)
  return cv.box(box.baseline)
}

// ---------------------------------------------------------------------------
// Symbol tables (KaTeX's unicode tables are not exported from its bundle;
// these mirror them for characters terminals can show).
// ---------------------------------------------------------------------------

const SYMBOLS: Record<string, string> = {
  // Greek lowercase
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\delta': 'δ',
  '\\epsilon': 'ϵ',
  '\\varepsilon': 'ε',
  '\\zeta': 'ζ',
  '\\eta': 'η',
  '\\theta': 'θ',
  '\\vartheta': 'ϑ',
  '\\iota': 'ι',
  '\\kappa': 'κ',
  '\\lambda': 'λ',
  '\\mu': 'μ',
  '\\nu': 'ν',
  '\\xi': 'ξ',
  '\\omicron': 'ο',
  '\\pi': 'π',
  '\\varpi': 'ϖ',
  '\\rho': 'ρ',
  '\\varrho': 'ϱ',
  '\\sigma': 'σ',
  '\\varsigma': 'ς',
  '\\tau': 'τ',
  '\\upsilon': 'υ',
  '\\phi': 'ϕ',
  '\\varphi': 'φ',
  '\\chi': 'χ',
  '\\psi': 'ψ',
  '\\omega': 'ω',
  // Greek uppercase
  '\\Gamma': 'Γ',
  '\\Delta': 'Δ',
  '\\Theta': 'Θ',
  '\\Lambda': 'Λ',
  '\\Xi': 'Ξ',
  '\\Pi': 'Π',
  '\\Sigma': 'Σ',
  '\\Upsilon': 'Υ',
  '\\Phi': 'Φ',
  '\\Psi': 'Ψ',
  '\\Omega': 'Ω',
  // Relations
  '\\leq': '≤',
  '\\le': '≤',
  '\\geq': '≥',
  '\\ge': '≥',
  '\\neq': '≠',
  '\\ne': '≠',
  '\\equiv': '≡',
  '\\approx': '≈',
  '\\cong': '≅',
  '\\sim': '∼',
  '\\simeq': '≃',
  '\\propto': '∝',
  '\\ll': '≪',
  '\\gg': '≫',
  '\\prec': '≺',
  '\\succ': '≻',
  '\\models': '⊨',
  '\\vdash': '⊢',
  '\\perp': '⊥',
  '\\parallel': '∥',
  '\\mid': '∣',
  // Set / logic
  '\\in': '∈',
  '\\notin': '∉',
  '\\ni': '∋',
  '\\subset': '⊂',
  '\\subseteq': '⊆',
  '\\supset': '⊃',
  '\\supseteq': '⊇',
  '\\cup': '∪',
  '\\cap': '∩',
  '\\emptyset': '∅',
  '\\varnothing': '∅',
  '\\forall': '∀',
  '\\exists': '∃',
  '\\nexists': '∄',
  '\\neg': '¬',
  '\\land': '∧',
  '\\lor': '∨',
  '\\therefore': '∴',
  '\\because': '∵',
  // Arrows
  '\\to': '→',
  '\\rightarrow': '→',
  '\\leftarrow': '←',
  '\\gets': '←',
  '\\leftrightarrow': '↔',
  '\\Rightarrow': '⇒',
  '\\Leftarrow': '⇐',
  '\\Leftrightarrow': '⇔',
  '\\mapsto': '↦',
  '\\implies': '⟹',
  '\\iff': '⟺',
  '\\uparrow': '↑',
  '\\downarrow': '↓',
  '\\nearrow': '↗',
  '\\searrow': '↘',
  // Binary ops
  '\\times': '×',
  '\\div': '÷',
  '\\pm': '±',
  '\\mp': '∓',
  '\\cdot': '⋅',
  '\\ast': '∗',
  '\\star': '⋆',
  '\\circ': '∘',
  '\\bullet': '∙',
  '\\oplus': '⊕',
  '\\ominus': '⊖',
  '\\otimes': '⊗',
  '\\oslash': '⊘',
  '\\odot': '⊙',
  '\\bigcirc': '◯',
  '\\setminus': '∖',
  '\\amalg': '⨿',
  '\\dagger': '†',
  '\\triangleleft': '⊲',
  '\\triangleright': '⊳',
  // Misc
  '\\infty': '∞',
  '\\partial': '∂',
  '\\nabla': '∇',
  '\\surd': '√',
  '\\sqrtsign': '√',
  '\\prime': '′',
  '\\ldots': '…',
  '\\dots': '…',
  '\\cdots': '⋯',
  '\\ddots': '⋱',
  '\\vdots': '⋮',
  '\\varvdots': '⋮',
  '\\angle': '∠',
  '\\triangle': '△',
  '\\hbar': 'ℏ',
  '\\ell': 'ℓ',
  '\\Re': 'ℜ',
  '\\Im': 'ℑ',
  '\\aleph': 'ℵ',
  '\\wp': '℘',
  '\\imath': 'ı',
  '\\jmath': 'ȷ',
  '\\checkmark': '✓',
  '\\degree': '°',
  '\\copyright': '©',
  '\\pounds': '£',
  '\\S': '§',
  '\\P': '¶',
  '\\top': '⊤',
  '\\bot': '⊥',
  '\\diamond': '⋄',
  '\\boxplus': '⊞',
  '\\boxtimes': '⊠',
  '\\wr': '≀',
  '@cdots': '⋯',
  '@ldots': '…',
}

/** Big-operator glyph table. */
const BIG_OPS: Record<string, string> = {
  '\\sum': '∑',
  '\\prod': '∏',
  '\\coprod': '∐',
  '\\int': '∫',
  '\\iint': '∬',
  '\\iiint': '∭',
  '\\oint': '∮',
  '\\bigcup': '⋃',
  '\\bigcap': '⋂',
  '\\biguplus': '⨄',
  '\\bigsqcup': '⨆',
  '\\bigvee': '⋁',
  '\\bigwedge': '⋀',
  '\\bigoplus': '⨁',
  '\\bigotimes': '⨂',
  '\\bigodot': '⨀',
}

/** Operators carrying limits above/below in display mode (int-class keep
 * trailing scripts — terminals cannot slimit big glyphs). */
const LIMIT_BELOW_OPS = new Set([
  '\\sum',
  '\\prod',
  '\\coprod',
  '\\bigcup',
  '\\bigcap',
  '\\biguplus',
  '\\bigsqcup',
  '\\bigvee',
  '\\bigwedge',
  '\\bigoplus',
  '\\bigotimes',
  '\\bigodot',
  '\\lim',
  '\\limsup',
  '\\liminf',
  '\\max',
  '\\min',
  '\\sup',
  '\\inf',
])

/** Accent label → single cell drawn centered in the row above the base. */
const ACCENTS: Record<string, string> = {
  '\\hat': '^',
  '\\widehat': '^',
  '\\bar': '‾',
  '\\overline': '─',
  '\\vec': '→',
  '\\tilde': '~',
  '\\widetilde': '~',
  '\\dot': '˙',
  '\\ddot': '¨',
  '\\check': 'ˇ',
  '\\acute': '´',
  '\\grave': '`',
  '\\breve': '˘',
}

/** Size-0/1 delimiter chars (`\left`/`\right` grids ≤ 2 rows use these). */
const DELIMS: Record<string, string> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '\\{': '{',
  '\\}': '}',
  '\\langle': '⟨',
  '\\rangle': '⟩',
  '|': '|',
  '\\vert': '|',
  '\\rvert': '|',
  '\\Vert': '‖',
  '\\rVert': '‖',
  '\\lvert': '|',
  '\\lVert': '‖',
  '.': '',
}

/** Stretching delimiter pieces for grids of 3+ rows. */
const STRETCH: Record<string, { top: string; mid: string; bot: string }> = {
  '(': { top: '⎛', mid: '⎜', bot: '⎝' },
  ')': { top: '⎞', mid: '⎟', bot: '⎠' },
  '[': { top: '⎡', mid: '⎢', bot: '⎣' },
  ']': { top: '⎤', mid: '⎥', bot: '⎦' },
  '\\{': { top: '⎧', mid: '⎪', bot: '⎩' },
  '\\}': { top: '⎫', mid: '⎪', bot: '⎬' },
  '|': { top: '|', mid: '|', bot: '|' },
  '\\vert': { top: '|', mid: '|', bot: '|' },
  '\\rvert': { top: '|', mid: '|', bot: '|' },
  '\\lvert': { top: '|', mid: '|', bot: '|' },
  '\\Vert': { top: '‖', mid: '‖', bot: '‖' },
  '\\rVert': { top: '‖', mid: '‖', bot: '‖' },
  '\\lVert': { top: '‖', mid: '‖', bot: '‖' },
  '\\langle': { top: '⟨', mid: '│', bot: '⟩' },
  '\\rangle': { top: '⟩', mid: '│', bot: '⟩' },
}

/**
 * Write a delimiter column over all `cv.height` rows at column `x`.
 * Grids of 1-2 rows repeat the plain char; 3+ rows get stretch pieces.
 */
function placeDelim(cv: Canvas, delim: string, x: number): void {
  if (delim === '.' || x >= cv.width) return
  const plain = DELIMS[delim]
  const p = STRETCH[delim]
  const cell = (ch: string | undefined, r: number): void => {
    const row = cv.rows[r]
    if (row && ch) row[x] = firstCell(ch)
  }
  if (cv.height <= 2 || !p) {
    const ch = plain ?? p?.mid ?? '?'
    for (let r = 0; r < cv.height; r++) cell(ch, r)
    return
  }
  for (let r = 0; r < cv.height; r++) {
    cell(r === 0 ? p.top : r === cv.height - 1 ? p.bot : p.mid, r)
  }
}

// ---------------------------------------------------------------------------
// Kern / spacing
// ---------------------------------------------------------------------------

/** Map a KaTeX spacing dimension to terminal cells (\,→1, \;→2, quad→4). */
function dimToCells(d: Dim | undefined): number {
  if (!d) return 0
  switch (d.unit) {
    case 'mu':
      // 18mu ≈ 1em ≈ 8 cells: \, (3mu) → 1, \; (6mu) → 2, \! (-3mu) → -1
      return Math.round(d.number / 3)
    case 'em':
      return Math.round(d.number * 4) // \quad → 4, \qquad → 8
    case 'ex':
      return Math.round(d.number * 2)
    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Node rendering
// ---------------------------------------------------------------------------

function renderList(nodes: Nd[] | undefined): GlyphBox {
  if (!nodes || nodes.length === 0) return EMPTY
  const out: GlyphBox[] = []
  for (const b of nodes.map(renderNode)) {
    if (b.width < 0) {
      // \! eats a cell from the sequence so far.
      const prev = out[out.length - 1]
      if (prev && prev.width + b.width >= 0) {
        const w = prev.width + b.width
        if (w === 0) out.pop()
        else
          out[out.length - 1] = {
            lines: prev.lines.map(l => l.slice(0, w)),
            width: w,
            baseline: prev.baseline,
          }
      }
      continue
    }
    out.push(b)
  }
  return hcat(out)
}

/** Render a field that is either a single node or a node list. */
function renderGroup(field: unknown): GlyphBox {
  if (Array.isArray(field)) return renderList(field as Nd[])
  if (field && typeof field === 'object') return renderNode(field as Nd)
  return EMPTY
}

function renderNode(node: Nd): GlyphBox {
  switch (node.type) {
    case 'ordgroup':
    case 'group':
    case 'styling':
    case 'color':
    case 'font':
    case 'text':
    case 'operatorname':
    case 'mclass':
    case 'raw':
    case 'url':
    case 'href':
    case 'tag':
      return renderList(node.body as Nd[] | undefined)

    case 'mathord':
    case 'textord':
    case 'atom':
    case 'punct':
    case 'inner': {
      const t = String(node.text ?? '')
      if (t.startsWith('\\')) {
        const sym = SYMBOLS[t] ?? BIG_OPS[t]
        if (!sym) return glyphBox('?')
        if (node.type === 'atom' && node.family === 'bin')
          return glyphBox(` ${sym} `)
        return glyphBox(sym)
      }
      if (node.type === 'atom' && node.family === 'bin')
        return glyphBox(` ${t} `)
      return glyphBox(t || '?')
    }

    case 'op': {
      const name = String(node.name ?? '')
      const glyph = BIG_OPS[name] ?? name.replace(/^\\+/, '')
      return glyphBox(glyph || '?')
    }

    case 'kern': {
      const n = dimToCells(node.dimension as Dim | undefined)
      if (n === 0) return EMPTY
      if (n > 0) return { lines: [' '.repeat(n)], width: n, baseline: 0 }
      return { lines: [''], width: n, baseline: 0 } // negative: eats cells
    }

    case 'spacing': // \nobreak etc — no visible cells
      return EMPTY

    case 'supsub':
      return renderSupSub(node)

    case 'genfrac':
      return renderFrac(node)

    case 'sqrt':
      return renderSqrt(node)

    case 'leftright':
      return renderLeftRight(node)

    case 'delimsizing': {
      const delim = String(node.delim ?? '')
      const size = Number(node.size ?? 1)
      if (delim === '.') return EMPTY
      if (size >= 3) {
        // \Bigg-class: a two-cell top/bottom pair reads better than one char.
        const p = STRETCH[delim]
        if (p) {
          return { lines: [p.top, p.bot], width: 1, baseline: 1 }
        }
      }
      return glyphBox(DELIMS[delim] ?? '?')
    }

    case 'accent':
      return renderAccent(node)

    case 'overline': {
      const b = renderGroup(node.body)
      const w = Math.max(b.width, 1)
      const cv = new Canvas(w, b.lines.length + 1)
      cv.place(b, 0, b.baseline + 1)
      cv.hline(0, 0, w, '─')
      return cv.box(b.baseline + 1)
    }

    case 'underline': {
      const b = renderGroup(node.body)
      const w = Math.max(b.width, 1)
      const cv = new Canvas(w, b.lines.length + 1)
      cv.place(b, 0, b.baseline)
      cv.hline(cv.height - 1, 0, w, '_')
      return cv.box(b.baseline)
    }

    case 'array':
      return renderArray(node)

    case 'htmlmathml': {
      // e.g. \neq — the mathml branch carries the real unicode char.
      const ml = node.mathml as Nd[] | undefined
      if (Array.isArray(ml) && ml.length > 0) return renderList(ml)
      return renderList(node.html as Nd[] | undefined)
    }

    case 'lap':
      return renderNode(node.body as Nd)

    case 'phantom':
      return renderList(node.body as Nd[] | undefined)

    case 'smash':
      return renderNode(node.body as Nd)

    case 'rule':
      return glyphBox(' '.repeat(Math.max(1, dimToCells(node.width as Dim))))

    default:
      // Degradation level 2: recurse into children, else raw arg text, else ?.
      if (Array.isArray(node.body)) return renderList(node.body as Nd[])
      if (node.body) return renderNode(node.body as Nd)
      if (typeof node.text === 'string') return glyphBox(String(node.text))
      return glyphBox('?')
  }
}

function renderSupSub(node: Nd): GlyphBox {
  const baseNode = (node.base ?? {}) as Nd
  const base = renderGroup(node.base)
  const supNode = node.sup as Nd | undefined
  const subNode = node.sub as Nd | undefined
  const sup = supNode ? renderGroup(supNode) : null
  const sub = subNode ? renderGroup(subNode) : null
  if (!sup && !sub) return base

  const baseName = String((baseNode.name ?? baseNode.text ?? '') as string)
  const stacked =
    baseNode.limits === true &&
    (baseNode.type === 'op' || baseNode.type === 'operatorname') &&
    LIMIT_BELOW_OPS.has(baseName)

  if (stacked) {
    // Display-mode limits: above/below, centered on the operator.
    const width = Math.max(base.width, sup?.width ?? 0, sub?.width ?? 0)
    const above = sup ? sup.lines.length : 0
    const below = sub ? sub.lines.length : 0
    const cv = new Canvas(width, above + base.lines.length + below)
    const axis = above + base.baseline
    cv.place(base, Math.floor((width - base.width) / 2), axis)
    if (sup) cv.place(sup, Math.floor((width - sup.width) / 2), sup.baseline)
    if (sub)
      cv.place(
        sub,
        Math.floor((width - sub.width) / 2),
        above + base.lines.length + sub.baseline,
      )
    return cv.box(axis)
  }

  // Trailing scripts: sup's baseline sits one row above the base axis, sub's
  // one row below (nested scripts add rows via their own box heights).
  const scriptWidth = Math.max(sup?.width ?? 0, sub?.width ?? 0)
  const rowsAbove = Math.max(base.baseline, sup ? 1 + sup.baseline : 0)
  const rowsBelow = Math.max(
    base.lines.length - 1 - base.baseline,
    sup ? Math.max(0, sup.lines.length - 1 - sup.baseline - 1) : 0,
    sub ? 1 + (sub.lines.length - 1 - sub.baseline) : 0,
  )
  const cv = new Canvas(base.width + scriptWidth, rowsAbove + 1 + rowsBelow)
  cv.place(base, 0, rowsAbove)
  if (sup) cv.place(sup, base.width, rowsAbove - 1)
  if (sub) cv.place(sub, base.width, rowsAbove + 1 + sub.baseline)
  return cv.box(rowsAbove)
}

function renderFrac(node: Nd): GlyphBox {
  const numer = renderGroup(node.numer)
  const denom = renderGroup(node.denom)
  const hasBar = node.hasBarLine !== false
  const width = Math.max(numer.width, denom.width, 1)
  const height = numer.lines.length + (hasBar ? 1 : 0) + denom.lines.length
  const cv = new Canvas(width, height)
  const barRow = numer.lines.length
  cv.place(centerIn(numer, width), 0, numer.baseline)
  if (hasBar) cv.hline(barRow, 0, width, '─')
  cv.place(
    centerIn(denom, width),
    0,
    barRow + (hasBar ? 1 : 0) + denom.baseline,
  )
  let box = cv.box(hasBar ? barRow : numer.lines.length - 1)
  // \binom / \choose / \atop: delimiters stretched to the stack height.
  const left = node.leftDelim as string | null | undefined
  const right = node.rightDelim as string | null | undefined
  if (left || right) {
    const l = left ?? '.'
    const r = right ?? '.'
    const lw = l === '.' ? 0 : 1
    const rw = r === '.' ? 0 : 1
    const wrapped = new Canvas(box.width + lw + rw, box.lines.length)
    wrapped.place(box, lw, box.baseline)
    if (lw) placeDelim(wrapped, l, 0)
    if (rw) placeDelim(wrapped, r, wrapped.width - 1)
    box = wrapped.box(box.baseline)
  }
  return box
}

function renderSqrt(node: Nd): GlyphBox {
  const rad = renderGroup(node.body)
  const width = Math.max(rad.width, 1) + 2
  const cv = new Canvas(width, rad.lines.length + 1)
  cv.place(rad, 2, rad.baseline + 1)
  cv.hline(0, 1, width - 1, '─')
  const overRow = cv.rows[0]
  if (overRow) overRow[0] = '√'
  let box = cv.box(rad.baseline + 1)
  const indexNode = node.index as Nd | undefined
  if (indexNode) {
    // Optional index sits above the radical sign.
    const idx = renderGroup(indexNode)
    const big = new Canvas(
      Math.max(width, idx.width),
      box.lines.length + idx.lines.length,
    )
    big.place(box, 0, idx.lines.length + box.baseline)
    big.place(idx, 0, idx.baseline)
    box = big.box(idx.lines.length + box.baseline)
  }
  return box
}

function renderLeftRight(node: Nd): GlyphBox {
  const inner = renderList(node.body as Nd[] | undefined)
  const left = String(node.left ?? '.')
  const right = String(node.right ?? '.')
  const lw = left === '.' ? 0 : 1
  const rw = right === '.' ? 0 : 1
  const width = Math.max(inner.width, 1) + lw + rw
  const height = Math.max(inner.lines.length, 1)
  const cv = new Canvas(width, height)
  cv.place(inner, lw, inner.baseline)
  if (lw) placeDelim(cv, left, 0)
  if (rw) placeDelim(cv, right, width - 1)
  return cv.box(inner.baseline)
}

function renderAccent(node: Nd): GlyphBox {
  const base = renderGroup(node.base)
  const label = String(node.label ?? '')
  const w = Math.max(base.width, 1)
  const ch = ACCENTS[label] ?? '?'
  const cv = new Canvas(w, base.lines.length + 1)
  cv.place(base, 0, base.baseline + 1)
  const row = cv.rows[0]
  if (row) {
    const start = Math.floor((w - Math.min(stringWidth(ch), w)) / 2)
    row[start] = firstCell(ch)
  }
  return cv.box(base.baseline + 1)
}

function renderArray(node: Nd): GlyphBox {
  const rowsNode = node.body as Nd[][] | undefined
  if (!Array.isArray(rowsNode) || rowsNode.length === 0) return EMPTY
  const cols = (node.cols as Nd[] | undefined) ?? []
  const cells = rowsNode.map(row => row.map(renderNode))
  const colCount = Math.max(1, ...cells.map(r => r.length))

  // Column widths: max cell width per column (min 1), MarkdownTable-style.
  const colWidths: number[] = []
  const colAligns: string[] = []
  for (let c = 0; c < colCount; c++) {
    let w = 1
    for (const row of cells) {
      const cell = row[c]
      if (cell) w = Math.max(w, cell.width)
    }
    colWidths.push(w)
    colAligns.push(
      String((cols[c] as { align?: string } | undefined)?.align ?? 'c'),
    )
  }

  // One space column between columns keeps cells readable.
  const gap = 1
  const width =
    colWidths.reduce((s, w) => s + w, 0) + gap * Math.max(0, colCount - 1)

  const rowBoxes = cells.map(row => hcat(row.filter(b => b.width > 0)))
  // Rows share one baseline (max cell baseline, min 0 so single-row grids
  // still occupy a line); the array's axis is the middle row's axis.
  const rowBaselines = rowBoxes.map(rb => Math.max(0, rb.baseline))
  const rowHeights = rowBoxes.map(rb =>
    Math.max(1, rb.baseline + rb.lines.length - rb.baseline),
  )
  const totalHeight = rowHeights.reduce((s, h) => s + h, 0)
  const cv = new Canvas(width, totalHeight)
  let y = 0
  const rowAxes: number[] = []
  rowBoxes.forEach((_rb, i) => {
    const axis = y + rowBaselines[i]!
    rowAxes.push(axis)
    let x = 0
    cells[i]!.forEach((cell, c) => {
      if (c >= colCount) return
      const w = colWidths[c]!
      const align = colAligns[c]!
      const cellX =
        align === 'c'
          ? x + Math.floor((w - cell.width) / 2)
          : align === 'r'
            ? x + (w - cell.width)
            : x
      cv.place(cell, cellX, axis)
      x += w + gap
    })
    y += rowHeights[i]!
  })
  return cv.box(rowAxes[Math.floor(rowAxes.length / 2)]!)
}

// ---------------------------------------------------------------------------
// Entry point + LRU cache (streaming re-lexes the same closed blocks;
// MarkdownBody re-renders on every keystroke elsewhere in the transcript).
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 200
const cache = new Map<string, string | null>()

/** @internal test hook */
export function __mathGridLayoutCacheSize(): number {
  return cache.size
}

export interface MathLayoutOptions {
  /** Grids wider than this return null (caller draws the dim rail). */
  maxWidth?: number
}

/**
 * Typeset a closed display-math block into styled character-grid lines.
 * Returns the grid as one ANSI string (no trailing newline), or null when
 * the block should fall back to the dim rail: KaTeX parse error, or a grid
 * wider than `maxWidth`.
 */
export function renderMathGrid(
  latex: string,
  theme: ThemeName,
  opts: MathLayoutOptions = {},
): string | null {
  const key = `${latex}\u0000${opts.maxWidth ?? 'x'}`
  if (cache.has(key)) {
    const hit = cache.get(key)!
    cache.delete(key) // refresh LRU position
    cache.set(key, hit)
    return hit
  }
  const result = computeGrid(latex, theme, opts.maxWidth)
  cache.set(key, result)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string
    cache.delete(oldest)
  }
  return result
}

function computeGrid(
  latex: string,
  theme: ThemeName,
  maxWidth: number | undefined,
): string | null {
  if (!parse) return null
  let tree: Nd[]
  try {
    tree = parse(latex, { displayMode: true, strict: 'ignore' })
  } catch {
    return null // Degradation level 1: the caller draws the rail.
  }
  let box: GlyphBox
  try {
    box = renderList(tree)
  } catch {
    return null // Defensive: the layouter must never throw out of here.
  }
  if (box.width === 0 || box.lines.length === 0) return null
  if (maxWidth !== undefined && box.width > maxWidth) return null
  const style = color('permission', theme)
  return box.lines.map(l => style(l)).join('\n')
}
