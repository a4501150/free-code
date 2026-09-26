import { CellWidth, cellAtIndex, type Screen } from './screen.js'

/** One row of searchable screen text, pre-lowercased, with the cell
 *  mapping needed to translate string offsets back to screen columns. */
export type SearchableRow = {
  /** Concatenated chars of the included cells, each lowercased. */
  text: string
  /** Screen column of the Nth included cell — index into this array is a
   *  "cell index". */
  colOf: number[]
  /** Maps a code-unit offset in `text` to a cell index in `colOf`.
   *  Needed because code-unit length ≠ cell count for surrogate pairs
   *  (emoji) and multi-unit lowercasings (Turkish İ → i + U+0307). */
  codeUnitToCell: number[]
}

/**
 * Build the searchable text for one screen row: same skip rules used by
 * both search consumers (applySearchHighlight in searchHighlight.ts and
 * scanPositions in render-to-screen.ts — "highlight what you see" for
 * content, gutters excluded):
 *   - SpacerTail: 2nd cell of a wide char, no char of its own
 *   - SpacerHead: end-of-line padding when a wide char wraps
 *   - noSelect: gutters (⎿, line numbers) — same exclusion as
 *     applySelectionOverlay.
 *
 * Lowercasing is per-char (not on the joined string at the end) so
 * codeUnitToCell maps positions in the LOWERCASED text — lowering after
 * joining desyncs indexOf positions from the map for multi-unit
 * lowercasings.
 */
export function buildSearchableRow(screen: Screen, row: number): SearchableRow {
  const w = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * w
  let text = ''
  const colOf: number[] = []
  const codeUnitToCell: number[] = []
  for (let col = 0; col < w; col++) {
    const idx = rowOff + col
    const cell = cellAtIndex(screen, idx)
    if (
      cell.width === CellWidth.SpacerTail ||
      cell.width === CellWidth.SpacerHead ||
      noSelect[idx] === 1
    ) {
      continue
    }
    const lc = cell.char.toLowerCase()
    const cellIdx = colOf.length
    for (let i = 0; i < lc.length; i++) {
      codeUnitToCell.push(cellIdx)
    }
    text += lc
    colOf.push(col)
  }
  return { text, colOf, codeUnitToCell }
}
