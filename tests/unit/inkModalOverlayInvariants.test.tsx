/**
 * Absolute-overlay × scroll interplay invariants, checked through the REAL
 * virtualization + fast-path machinery — the in-process twin of the
 * dialog-round-trip e2e (render-invariant-checks.test.ts).
 *
 * Pins four bugs found via the e2e's flaky dialog-window RENDER-CHECK
 * blank (frame rows blank/ghosted vs a cache-free reference while an
 * absolute bottom modal is open over a sticky-growing transcript):
 *   1. The render-check reference render consumed the absoluteRects
 *      rotation (resetScrollHint rotated the lists), so the NEXT real
 *      frame's scroll-fast-path pass-3 repair ran with an empty
 *      absoluteRectsPrev and never wiped the modal's shift-ghosted
 *      pixels (the modal border drifting up one row per growth frame).
 *   2. A dirty absolute overlay's fromAbsolute clear made output.get()
 *      exclude every blit in its rect — including the overlay's OWN
 *      clean children — so the overlay's unchanged rows (border,
 *      headers) went blank whenever any sibling child updated.
 *   3. The same blanket exclusion also blanked the scroll content's
 *      clean children blitting UNDER a transparent overlay (the
 *      transcript visible at columns beyond the overlay's texts).
 *      The exclusion is now scoped to geometry changes only, where the
 *      overlay's fresh paint no longer covers its old rect.
 *   4. A clean scroll child whose rows sit under an absolute overlay
 *      now full-renders instead of blitting: its blit copies
 *      prevScreen's composite, which carries the overlay's OLD pixels —
 *      cells the overlay's fresh paint no longer covers (a shrunk
 *      overlay text) kept the overlay's stale tail ("tick 90": '9' from
 *      the new text + '0' restored from the old).
 *
 * The modal's output text oscillates length every tick (tick 9/tick 10)
 * to exercise the shrink class continuously; the transcript grows a
 * line every few ticks to drive sticky scroll + the fast path.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'

import { Box, Text } from '../../src/ink.js'
import ScrollBox from '../../src/ink/components/ScrollBox.js'
import type { ScrollBoxHandle } from '../../src/ink/components/ScrollBox.js'
import { useVirtualScroll } from '../../src/hooks/useVirtualScroll.js'
import { renderSync } from '../../src/ink/root.js'
import instances from '../../src/ink/instances.js'
import { checkLayoutInvariants } from '../../src/ink/layout-check.js'
import { diffFrameAgainstReference } from '../../src/ink/render-check.js'
import { invalidateNodeCache } from '../../src/ink/node-cache.js'
import { markLayoutShifted } from '../../src/ink/render-node-to-output.js'
import type { DOMElement } from '../../src/ink/dom.js'

const COLUMNS = 158
const ROWS = 40

function fakeStdout(columns = COLUMNS, rows = ROWS): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  Object.assign(stream, { columns, rows, isTTY: true })
  return stream
}

const GLYPHS = ['✻', '✽', '✶', '✳', '✢', '·']
const VERBS = ['Honking', 'Wandering', 'Ebbing', 'Pondering', 'Dreaming']

type Item = { key: string; lines: string[] }

const line = (tag: string, i: number): string =>
  `${tag} line ${i}: some analysis prose that wraps across the pane width`

function VList({
  items,
  scrollRef,
  columns,
}: {
  items: Item[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  columns: number
}) {
  const keys = React.useMemo(() => items.map(i => i.key), [items])
  const { range, topSpacer, bottomSpacer, measureRef, spacerRef } =
    useVirtualScroll(scrollRef, keys, columns)
  const [start, end] = range
  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {items.slice(start, end).map((it, i) => (
        <Box
          key={it.key}
          ref={measureRef(it.key)}
          flexDirection="column"
          marginTop={i === 0 ? undefined : 1}
        >
          {it.lines.map((l, j) => (
            <Text key={j}>{l}</Text>
          ))}
        </Box>
      ))}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
    </>
  )
}

function App({
  items,
  tick,
  modalOpen,
  scrollRef,
}: {
  items: Item[]
  tick: number
  modalOpen: boolean
  scrollRef: React.RefObject<ScrollBoxHandle | null>
}) {
  return (
    <Box flexDirection="column" height={ROWS}>
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexDirection="column"
        paddingTop={1}
        stickyScroll
      >
        <Text>free-code v1.0 header</Text>
        <VList items={items} scrollRef={scrollRef} columns={COLUMNS} />
        <Box flexGrow={1} />
        <Box marginTop={1} flexDirection="column" width="100%">
          <Text>
            {GLYPHS[tick % GLYPHS.length]} {VERBS[tick % VERBS.length]}…
          </Text>
        </Box>
      </ScrollBox>
      {/* DialogSlot-style overlay: absolute bottom pane, transparent
          (no background), growing content, and one text whose LENGTH
          oscillates every tick — the shrink-tail exercise. */}
      {modalOpen ? (
        <Box
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          height={31}
          flexDirection="column"
          width="100%"
        >
          <Text>▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔</Text>
          <Text> Monitor details</Text>
          <Text> Output:</Text>
          {Array.from({ length: 12 }, (_, i) => (
            <Text key={i}> │ monitor tick {i + (tick % 2)}</Text>
          ))}
          <Text> ← to go back · Esc/Enter/Space to close</Text>
        </Box>
      ) : null}
    </Box>
  )
}

describe('absolute overlay scroll invariants', () => {
  test('modal over sticky-growing transcript keeps layout and frame clean', () => {
    const stdout = fakeStdout()
    const items: Item[] = Array.from({ length: 30 }, (_, i) => ({
      key: `seed-${i}`,
      lines: Array.from({ length: 3 }, (_, j) => line(`Seed${i}`, j)),
    }))
    const scrollRef =
      React.createRef<ScrollBoxHandle>() as React.RefObject<ScrollBoxHandle | null>
    const instance = renderSync(
      <App items={items} tick={0} modalOpen={false} scrollRef={scrollRef} />,
      {
        stdout,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    const ink = instances.get(stdout) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: Parameters<typeof diffFrameAgainstReference>[1] }
      stylePool: Parameters<typeof diffFrameAgainstReference>[2]
      invalidateLayoutCache: () => void
    }
    const layoutViolations: string[] = []
    const renderDivergences: string[] = []
    // The flip invalidations the real app runs via useFlipInvalidation
    // (which reads process.stdout, unavailable under the fake stream).
    const flip = (): void => {
      invalidateNodeCache()
      ink.invalidateLayoutCache()
      markLayoutShifted()
    }
    try {
      let modalOpen = false
      for (let tick = 1; tick <= 60; tick++) {
        if (tick % 5 === 0) {
          // Monitor stream: the tail item grows a line, driving sticky
          // scroll and the fast path while the modal is open.
          items.push({ key: `grow-${tick}`, lines: [`grow line ${tick}`] })
          items.splice(0, 1)
        }
        if (tick === 11) {
          modalOpen = true
          flip()
        }
        if (tick === 41) {
          modalOpen = false
          flip()
        }
        instance.rerender(
          <App
            items={items}
            tick={tick}
            modalOpen={modalOpen}
            scrollRef={scrollRef}
          />,
        )
        const found = checkLayoutInvariants(ink.rootNode)
        if (found.length > 0)
          layoutViolations.push(`tick ${tick} (open=${modalOpen}): ${found[0]}`)
        const mismatches = diffFrameAgainstReference(
          ink.rootNode,
          ink.frontFrame.screen,
          ink.stylePool,
        )
        if (mismatches.length > 0) {
          const first = mismatches[0] as (typeof mismatches)[0] & {
            frameRow?: string
            referenceRow?: string
          }
          renderDivergences.push(
            `tick ${tick} (open=${modalOpen}): row ${mismatches[0]!.row} F=${first.frameRow?.slice(0, 40) ?? '?'} R=${first.referenceRow?.slice(0, 40) ?? '?'}`,
          )
        }
      }
      expect(layoutViolations).toEqual([])
      expect(renderDivergences).toEqual([])
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
