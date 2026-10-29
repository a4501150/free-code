import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../../src/utils/markdown.js'

function render(content: string): string {
  return stripAnsi(applyMarkdown(content, 'dark', null))
}

const BT = String.fromCharCode(96)

describe('markdown table pipe handling', () => {
  test('plain table still renders', () => {
    const out = render(['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'))
    expect(out).toContain('| A')
    expect(out).toContain('| 1')
    expect(out).not.toContain('|---|---|')
  })

  test('raw pipe inside a cell code span does not blank the table', () => {
    const md = [
      `| Harness | Bans ${BT}| tail${BT}? |`,
      '|---|---|',
      `| Codex | No |`,
    ].join('\n')
    const out = render(md)
    // Rendered as a table: the delimiter row is replaced by a padded one and
    // the header cell shows the code span content, not the escaped source.
    // Cell renders its content; the codespan backticks are consumed by the
    // renderer, so assert on text and on the absence of the escape marker.
    expect(out).toContain('Bans | tail?')
    expect(out).not.toContain('\\|')
    expect(out).toMatch(/-{4,}/)
  })

  test('pre-escaped pipe still renders', () => {
    const md = [
      `| Harness | Bans ${BT}\\| tail${BT}? |`,
      '|---|---|',
      '| Codex | No |',
    ].join('\n')
    const out = render(md)
    expect(out).toContain('Bans | tail?')
    expect(out).not.toContain('\\|')
  })

  test('pipe-containing code span outside a table is untouched', () => {
    const out = render(
      `Run ${BT}a | b${BT} first\n\n| A | B |\n|---|---|\n| 1 | 2 |`,
    )
    expect(out).toContain('Run a | b first')
    expect(out).not.toContain('\\|')
    expect(out).toContain('| 1')
  })

  test('table preceded by a pipe code-span paragraph renders both', () => {
    const md = [
      `Never pipe to ${BT}| head${BT}.`,
      '',
      `| Harness | Bans ${BT}| tail${BT}? |`,
      '|---|---|',
      '| Codex | No |',
    ].join('\n')
    const out = render(md)
    expect(out).toContain('Never pipe to')
    expect(out).toContain('Bans')
    expect(out).toMatch(/-{4,}/)
  })
})
