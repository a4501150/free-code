/**
 * Suspense hide/unhide roundtrip — the hideInstance/unhideInstance
 * lifecycle ShellDetailDialog's deferred output drives in production.
 *
 * Pins three fixes:
 *   1. unhideInstance restores yoga display from the node's own style,
 *      not a hardcoded Flex: a style-level display:none child stays
 *      hidden through the cycle (previously the reveal un-hid it and
 *      its text leaked into the frame).
 *   2. hideInstance prunes focus: the activeElement inside the hidden
 *      subtree blurs and focus restores from the stack, and Tab cycling
 *      skips the hidden subtree (collectTabbable filters isHidden /
 *      display:none).
 *   3. The hidden subtree leaves the frame and its content returns on
 *      reveal.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'

import { Box, Text } from '../../src/ink.js'
import { renderSync } from '../../src/ink/root.js'
import instances from '../../src/ink/instances.js'
import type { DOMElement, TextNode } from '../../src/ink/dom.js'
import { LayoutDisplay } from '../../src/ink/layout/node.js'
import { cellAtIndex } from '../../src/ink/screen.js'

const COLUMNS = 80
const ROWS = 10

function fakeStdout(columns = COLUMNS, rows = ROWS): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  Object.assign(stream, { columns, rows, isTTY: true })
  return stream
}

let release: (() => void) | null = null

function Suspender({ suspend }: { suspend: boolean }): React.ReactNode {
  if (suspend && release === null) {
    throw new Promise<void>(resolve => {
      release = resolve
    })
  }
  return (
    <Box flexDirection="column" tabIndex={0}>
      <Text>panel content A</Text>
    </Box>
  )
}

function App({ suspend, tick }: { suspend: boolean; tick: number }) {
  return (
    <Box flexDirection="column">
      <Box tabIndex={0}>
        <Text>outside focus target</Text>
      </Box>
      {/* A style-level display:none subtree as a SEPARATE boundary child:
          React hides/unhides each boundary child's top host instance, so
          this box receives the full hideInstance/unhideInstance cycle —
          the discriminator for the per-style display restore. */}
      <React.Suspense fallback={<Text>loading output…</Text>}>
        <Suspender suspend={suspend} />
        <Box display="none">
          <Text>ghost row</Text>
        </Box>
      </React.Suspense>
      <Text>tick {tick}</Text>
    </Box>
  )
}

function collectElements(
  node: DOMElement,
  out: DOMElement[] = [],
): DOMElement[] {
  out.push(node)
  for (const c of node.childNodes) {
    if (c.nodeName !== '#text') collectElements(c as DOMElement, out)
  }
  return out
}

function subtreeText(node: DOMElement): string {
  let out = ''
  const walk = (n: DOMElement): void => {
    for (const c of n.childNodes) {
      if (c.nodeName === '#text') out += (c as TextNode).nodeValue
      else walk(c as DOMElement)
    }
  }
  walk(node)
  return out
}

function frameText(screen: { width: number; height: number }): string {
  const rows: string[] = []
  for (let r = 0; r < screen.height; r++) {
    let out = ''
    for (let c = 0; c < screen.width; c++) {
      const ch = cellAtIndex(screen as never, r * screen.width + c).char
      out += ch ?? ' '
    }
    rows.push(out.replace(/\s+$/g, ''))
  }
  return rows.join('\n')
}

describe('suspense hide/unhide lifecycle', () => {
  test('hidden subtree drops from frame and focus; reveal restores per-style display', async () => {
    const stdout = fakeStdout()
    const instance = renderSync(<App suspend={false} tick={1} />, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const ink = instances.get(stdout) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: { width: number; height: number } }
    }
    const root = ink.rootNode
    try {
      // -- Locate the actors by content.
      const els = collectElements(root)
      const outsideBox = els.find(
        e => subtreeText(e) === 'outside focus target',
      )!
      expect(outsideBox).toBeDefined()
      const panelText = (e: DOMElement) => subtreeText(e)
      const panelBox = els.find(
        e =>
          e.nodeName === 'ink-box' &&
          panelText(e).includes('panel content A') &&
          !panelText(e).includes('outside focus target'),
      )!
      expect(panelBox).toBeDefined()
      const ghostBox = els.find(
        e => e.nodeName === 'ink-box' && e.style.display === 'none',
      )!
      expect(ghostBox).toBeDefined()

      // -- Initial: everything live, ghost never painted.
      let text = frameText(ink.frontFrame.screen)
      expect(text).toContain('panel content A')
      expect(text).toContain('tick 1')
      expect(text).not.toContain('ghost row')
      expect(text).not.toContain('loading output')

      // -- Focus the panel (inside the boundary), with outside as the
      // stack fallback.
      const fm = root.focusManager!
      fm.focus(outsideBox)
      fm.focus(panelBox)
      expect(fm.activeElement).toBe(panelBox)

      // -- Suspend on update: React hides the revealed subtree.
      release = null
      instance.rerender(<App suspend={true} tick={2} />)

      expect(panelBox.isHidden).toBe(true)
      expect(panelBox.yogaNode!.getDisplay()).toBe(LayoutDisplay.None)
      expect(ghostBox.isHidden).toBe(true)
      expect(ghostBox.yogaNode!.getDisplay()).toBe(LayoutDisplay.None)

      // Focus left the hidden subtree and restored from the stack.
      expect(fm.activeElement).toBe(outsideBox)

      // Frame: fallback painted, hidden content gone.
      text = frameText(ink.frontFrame.screen)
      expect(text).toContain('loading output')
      expect(text).toContain('tick 2')
      expect(text).not.toContain('panel content A')

      // Tab cycling cannot reach the hidden subtree.
      fm.focusNext(root)
      expect(fm.activeElement).not.toBe(panelBox)

      // -- Resolve + force the reveal render.
      release!()
      await new Promise(r => setTimeout(r, 20))
      instance.rerender(<App suspend={false} tick={3} />)

      expect(panelBox.isHidden).toBe(false)
      expect(panelBox.yogaNode!.getDisplay()).toBe(LayoutDisplay.Flex)

      // Style-level display:none SURVIVES the unhide (restored from
      // style, not hardcoded Flex).
      expect(ghostBox!.isHidden).toBe(false)
      expect(ghostBox!.yogaNode!.getDisplay()).toBe(LayoutDisplay.None)

      text = frameText(ink.frontFrame.screen)
      expect(text).toContain('panel content A')
      expect(text).toContain('tick 3')
      expect(text).not.toContain('ghost row')
      expect(text).not.toContain('loading output')

      // Tab order reaches the panel again.
      fm.focusNext(root)
      expect(fm.activeElement).toBe(panelBox)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
