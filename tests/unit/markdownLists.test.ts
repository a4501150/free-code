import { describe, expect, test } from 'bun:test'
import { applyMarkdown, configureMarked } from '../../src/utils/markdown.js'

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

configureMarked()

/**
 * marked 17 wraps every list item's content in a `paragraph` token (the old
 * `text`-child shape no longer occurs), and the renderer's bullet logic was
 * keyed off that dead shape — every list in the TUI rendered as run-on lines
 * with no marker, which read as "no line break after the previous
 * paragraph". These tests pin the bullet emission to the list_item case,
 * which is shape-agnostic.
 */
describe('markdown list rendering', () => {
  test('a list interrupting a paragraph keeps its bullets', () => {
    const out = stripAnsi(
      applyMarkdown('**Header line:**\n- first item\n- second item', 'dark'),
    )
    expect(out).toBe('Header line:\n- first item\n- second item')
  })

  test('tight and loose lists both render bullets', () => {
    expect(stripAnsi(applyMarkdown('- a\n- b', 'dark'))).toBe('- a\n- b')
    expect(stripAnsi(applyMarkdown('- a\n\n- b', 'dark'))).toBe('- a\n- b')
  })

  test('ordered lists render numbers', () => {
    expect(stripAnsi(applyMarkdown('1. first\n2. second', 'dark'))).toBe(
      '1. first\n2. second',
    )
  })

  test('nested lists indent', () => {
    expect(stripAnsi(applyMarkdown('- a\n  - b', 'dark'))).toBe('- a\n  - b')
  })

  test('a standalone list after a blank line still renders bullets', () => {
    const out = stripAnsi(applyMarkdown('para\n\n- item', 'dark'))
    expect(out).toContain('\n- item')
  })
})
