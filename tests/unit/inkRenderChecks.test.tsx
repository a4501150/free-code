/**
 * Tests for the render-cache diagnostics added after the monitor-detail
 * input-row leak:
 *
 * 1. Ink.invalidateLayoutCache() forces a cache-free yoga pass (the
 *    counter telemetry must show zero cache hits on the next frame).
 * 2. useFlipInvalidation fires invalidations on each flip edge, never on
 *    stable renders.
 * 3. useRegisterOverlay's cleanup wipes the yoga cache for modal overlays
 *    only — autocomplete (non-modal, absolutely-positioned) skips the
 *    full recompute.
 * 4. checkLayoutInvariants flags overlapping non-absolute siblings (the
 *    mixed-geometry signature) and exempts absolute ones by design.
 * 5. diffFrameAgainstReference: no divergence on healthy frames across
 *    subtree flips, and a missed-dirty corruption (DOM text mutated
 *    without a dirty flag — the render-cache bug class) IS detected.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'

import { Box, Text } from '../../src/ink.js'
import type Ink from '../../src/ink/ink.js'
import type { FrameEvent } from '../../src/ink/frame.js'
import { renderSync } from '../../src/ink/root.js'
import instances from '../../src/ink/instances.js'
import { useFlipInvalidation } from '../../src/ink/hooks/use-flip-invalidation.js'
import { checkLayoutInvariants } from '../../src/ink/layout-check.js'
import { diffFrameAgainstReference } from '../../src/ink/render-check.js'
import { useRegisterOverlay } from '../../src/context/overlayContext.js'
import { AppStateProvider } from '../../src/state/AppState.js'
import type { DOMElement, DOMNode } from '../../src/ink/dom.js'
import { LayoutDisplay } from '../../src/ink/layout/node.js'

// Ink needs columns/rows/isTTY at construction; a PassThrough provides
// write/on for everything else it touches outside a real terminal.
function fakeStdout(columns = 80, rows = 24): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  Object.assign(stream, { columns, rows, isTTY: true })
  return stream
}

const mountOptions = (onFrame?: (e: FrameEvent) => void) => ({
  stdout: fakeStdout(),
  patchConsole: false,
  exitOnCtrlC: false,
  ...(onFrame ? { onFrame } : {}),
})

function StaticTree() {
  return (
    <Box flexDirection="column">
      {Array.from({ length: 12 }, (_, i) => (
        <Box key={i}>
          <Text>static row {i}</Text>
        </Box>
      ))}
    </Box>
  )
}

function getInk(stdout: NodeJS.WriteStream): Ink {
  const ink = instances.get(stdout)
  if (!ink) throw new Error('Ink instance not registered for stdout')
  return ink
}

describe('render-cache diagnostics', () => {
  test('invalidateLayoutCache forces a cache-free yoga pass', () => {
    const frames: FrameEvent[] = []
    const stdout = fakeStdout()
    const instance = renderSync(<StaticTree />, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
      onFrame: f => frames.push(f),
    })
    const ink = getInk(stdout)
    // Spy on the yoga root's recursive cache wipe — the one-shot must
    // fire exactly once on the next layout pass and not again after.
    const rootYoga = (ink as unknown as { rootNode: DOMElement }).rootNode
      .yogaNode as unknown as {
      clearLayoutCacheRecursive: () => void
    }
    const origWipe = rootYoga.clearLayoutCacheRecursive.bind(rootYoga)
    let wipes = 0
    rootYoga.clearLayoutCacheRecursive = () => {
      wipes++
      origWipe()
    }
    try {
      // Identical rerenders: unchanged constraints hit yoga's layout
      // cache, and no wipe fires.
      instance.rerender(<StaticTree />)
      instance.rerender(<StaticTree />)
      const cached = frames.at(-1)!.phases
      expect(cached.yogaCacheHits).toBeGreaterThan(0)
      expect(wipes).toBe(0)

      // The one-shot wipe: next pass fully recomputes every node.
      ink.invalidateLayoutCache()
      instance.rerender(<StaticTree />)
      const wiped = frames.at(-1)!.phases
      expect(wipes).toBe(1)
      expect(wiped.yogaVisited).toBeGreaterThanOrEqual(cached.yogaVisited)

      // Consumed: further identical rerenders don't wipe again.
      instance.rerender(<StaticTree />)
      expect(wipes).toBe(1)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })

  test('useFlipInvalidation fires on each flip edge only', () => {
    const calls: number[] = []
    const spy = {
      invalidateLayoutCache: () => calls.push(calls.length),
    } as unknown as Ink
    instances.set(process.stdout, spy)
    try {
      function FlipProbe({ active }: { active: boolean }) {
        useFlipInvalidation(active)
        return null
      }
      const instance = renderSync(<FlipProbe active={false} />, mountOptions())
      try {
        // Initial render: ref seeds at false, no flip fires.
        expect(calls).toEqual([])
        instance.rerender(<FlipProbe active={true} />)
        expect(calls.length).toBe(1)
        // Same value: no flip.
        instance.rerender(<FlipProbe active={true} />)
        expect(calls.length).toBe(1)
        instance.rerender(<FlipProbe active={false} />)
        expect(calls.length).toBe(2)
      } finally {
        instance.unmount()
        instance.cleanup()
      }
    } finally {
      instances.delete(process.stdout)
    }
  })

  test('useRegisterOverlay cleanup wipes yoga cache for modal overlays only', async () => {
    // Each cleanup calls invalidatePrevFrame, and the yoga wipe only for
    // modal ids — the expected event sequence for select→autocomplete is
    // [prev, wipe] (select is modal) then [prev] (autocomplete isn't).
    const events: string[] = []
    const spy = {
      invalidatePrevFrame: () => events.push('prev'),
      invalidateLayoutCache: () => events.push('wipe'),
    } as unknown as Ink
    instances.set(process.stdout, spy)
    try {
      function OverlayProbe({ id }: { id: string }) {
        useRegisterOverlay(id, true)
        return null
      }
      const instance = renderSync(
        <AppStateProvider>
          <OverlayProbe id="select" />
        </AppStateProvider>,
        mountOptions(),
      )
      try {
        const rerender = (id: string, enabled: boolean) =>
          instance.rerender(
            <AppStateProvider>
              {enabled ? <OverlayProbe id={id} /> : <Box />}
            </AppStateProvider>,
          )
        // id change select → autocomplete: cleanup runs with the OLD
        // (modal) id — must wipe the yoga cache.
        rerender('autocomplete', true)
        await new Promise(r => setTimeout(r, 50))
        expect(events).toEqual(['prev', 'wipe'])

        // Unmount with the autocomplete id — non-modal, so the yoga
        // wipe must NOT fire.
        rerender('autocomplete', false)
        await new Promise(r => setTimeout(r, 50))
        expect(events).toEqual(['prev', 'wipe', 'prev'])
      } finally {
        instance.unmount()
        instance.cleanup()
      }
    } finally {
      instances.delete(process.stdout)
    }
  })

  test('checkLayoutInvariants flags overlapping non-absolute siblings', () => {
    const stubYoga = (rect: {
      x: number
      y: number
      width: number
      height: number
    }) => ({
      getDisplay: () => LayoutDisplay.Flex,
      getComputedLeft: () => rect.x,
      getComputedTop: () => rect.y,
      getComputedWidth: () => rect.width,
      getComputedHeight: () => rect.height,
    })
    const stubElem = (
      rect: { x: number; y: number; width: number; height: number },
      opts: { absolute?: boolean; children?: DOMElement[] } = {},
    ): DOMElement =>
      ({
        nodeName: 'ink-box',
        childNodes: opts.children ?? [],
        style: { position: opts.absolute ? 'absolute' : 'relative' },
        yogaNode: stubYoga(rect),
      }) as unknown as DOMElement

    const root = stubElem({ x: 0, y: 0, width: 80, height: 40 })
    const makeTree = (secondAbsolute: boolean, secondTop: number) =>
      stubElem(
        { x: 0, y: 0, width: 80, height: 40 },
        {
          children: [
            // First sibling: stale-tall rect (rows 0-29), like the
            // scroll container clipped at the modal-open viewport.
            stubElem({ x: 2, y: 0, width: 76, height: 30 }),
            stubElem(
              { x: 2, y: secondTop, width: 76, height: 10 },
              { absolute: secondAbsolute },
            ),
          ],
        },
      )

    // Non-absolute second sibling at rows 26-35 overlaps rows 26-29.
    root.childNodes = [
      stubElem({ x: 0, y: 0, width: 80, height: 40 }, { children: [] }),
    ]
    const overlapping = makeTree(false, 26)
    expect(checkLayoutInvariants(overlapping).length).toBe(1)

    // Absolute second sibling: overlap is by design, no violation.
    const absoluteOverlay = makeTree(true, 26)
    expect(checkLayoutInvariants(absoluteOverlay)).toEqual([])

    // Non-overlapping non-absolute siblings: clean.
    const clean = makeTree(false, 30)
    expect(checkLayoutInvariants(clean)).toEqual([])
  })

  test('diffFrameAgainstReference detects missed-dirty text, not healthy flips', () => {
    function TickApp({ tick, show }: { tick: number; show: boolean }) {
      return (
        <Box flexDirection="column">
          <Text>sentinel alpha</Text>
          <Text>tick {tick}</Text>
          {show ? (
            <Box>
              <Text>flip panel</Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    const stdout = fakeStdout()
    const instance = renderSync(<TickApp tick={0} show={true} />, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const ink = getInk(stdout) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: Parameters<typeof diffFrameAgainstReference>[1] }
      stylePool: Parameters<typeof diffFrameAgainstReference>[2]
    }
    const check = () =>
      diffFrameAgainstReference(
        ink.rootNode,
        ink.frontFrame.screen,
        ink.stylePool,
      )
    try {
      // Healthy frames — content updates and subtree flips — must match
      // the cache-free reference render exactly.
      instance.rerender(<TickApp tick={1} show={true} />)
      expect(check()).toEqual([])
      instance.rerender(<TickApp tick={1} show={false} />)
      expect(check()).toEqual([])
      instance.rerender(<TickApp tick={2} show={true} />)
      expect(check()).toEqual([])

      // Corrupt: mutate a text node's value without the dirty flag the
      // reconciler would set — the missed-dirty render-cache bug class.
      // The real frame blits the old text; the reference reads the DOM.
      const findText = (node: DOMNode): { nodeValue: string } | null => {
        for (const child of node.childNodes as DOMNode[]) {
          if (
            child.nodeName === '#text' &&
            child.nodeValue === 'sentinel alpha'
          )
            return child
          const nested = child.childNodes ? findText(child) : null
          if (nested) return nested
        }
        return null
      }
      const sentinel = findText(ink.rootNode)
      expect(sentinel).not.toBeNull()
      sentinel!.nodeValue = 'CORRUPTED sentinel'
      instance.rerender(<TickApp tick={3} show={true} />)
      const mismatches = check()
      expect(mismatches.length).toBeGreaterThan(0)
      expect(mismatches.some(m => m.referenceChar === 'C')).toBe(true)
      expect(mismatches.some(m => m.frameChar === 's')).toBe(true)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
