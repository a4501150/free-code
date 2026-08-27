import { describe, expect, test } from 'bun:test'
import Output from '../../src/ink/output.js'
import {
  CharPool,
  createScreen,
  diff,
  HyperlinkPool,
  StylePool,
} from '../../src/ink/screen.js'

describe('Ink force repaint', () => {
  test('forces equal blank cells through the screen diff', () => {
    const stylePool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const previous = createScreen(4, 2, stylePool, charPool, hyperlinkPool)
    const next = createScreen(4, 2, stylePool, charPool, hyperlinkPool)
    const output = new Output({
      width: 4,
      height: 2,
      stylePool,
      screen: next,
      previousScreen: previous,
    })

    output.forceRepaint({ x: 1, y: 0, width: 2, height: 2 })

    const changes = diff(previous, output.get())
    expect(changes.map(([point]) => point)).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ])
    expect(changes.every(([, removed, added]) => removed && added)).toBe(true)
    expect(changes.every(([, , added]) => added?.char === ' ')).toBe(true)
  })
})
