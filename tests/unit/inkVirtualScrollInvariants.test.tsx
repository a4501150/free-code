/**
 * Streaming-growth invariants through the REAL virtualization machinery
 * — the in-process twin of the e2e (render-invariant-checks.test.ts).
 * The real useVirtualScroll hook (heightCache measured one frame behind
 * Yoga, offsets/spacers built from those stale heights, sticky
 * tail-walk) inside a real ScrollBox mounted the way FullscreenLayout
 * mounts it (flexDirection column, paddingTop, stickyScroll), with
 * REPL's content structure: [pre-list sibling, virtualized items with
 * spacers, flexGrow spacer, spinner row].
 *
 * This is the structure that reproduced the two e2e render-check
 * signatures the simpler harness (inkStreamingInvariants.test.tsx)
 * could not — both were scroll FAST-PATH bugs, now fixed and pinned
 * here:
 *   1. The DECSTBM shift region started at the content wrapper's top
 *      instead of the container's clip rows, so translated content in
 *      the padding row above the wrapper was never blitted/shifted —
 *      the frame's top transcript row went missing on every scrolled
 *      frame.
 *   2. The shift displaced stale pixels into rows no child paints
 *      (margins above the spinner, vacated rows) — ghosts like the
 *      double spinner text during streaming and the double-`)` byline.
 *      A gap sweep now blanks uncovered stable rows.
 *   3. A clean EMPTY box (flexGrow spacer, no bg/border/children)
 *      blit-restored its rect, which fractional cover-rounding shares
 *      with the spinner's row. When the spinner text shrank
 *      (Pondering…→Ebbing…), the restored old tail survived the
 *      damage-only clear — trailing-fragment ghosts like the double-`)`
 *      byline on glyph-only churn. Paints-nothing boxes no longer blit.
 * Growth phases: batch arrivals (whole items appended) then
 * line-by-line streaming of the tail item, with the spinner glyph
 * churning every frame.
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
import type { DOMElement } from '../../src/ink/dom.js'

// e2e pane geometry: 158x40.
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

// Mirrors VirtualMessageList's render: fragment → [topSpacer Box,
// item Boxes (measureRef, flexDirection column), bottomSpacer Box].
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
          // Inter-item margin, like MessageRow's addMargin — margins feed
          // the wrapper's flex-basis/free-space math during the stretch
          // transition.
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

function App({ items, tick }: { items: Item[]; tick: number }) {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
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
    </Box>
  )
}

// Same tree, self-driving on two independent real timers (spinner clock
// 50ms, growth clock 33ms) like the real app's animation/stream clocks.
function LiveApp() {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const [tick, setTick] = React.useState(0)
  // Start SHORT (~22 rows) so growth crosses the 39-row viewport.
  const [items, setItems] = React.useState<Item[]>(() =>
    Array.from({ length: 10 }, (_, i) => ({
      key: `live-${i}`,
      lines: Array.from({ length: 2 + (i % 2) }, (_, j) => line(`Live${i}`, j)),
    })),
  )
  React.useEffect(() => {
    const spinner = setInterval(() => setTick(t => t + 1), 50)
    let appends = 0
    const growth = setInterval(() => {
      appends++
      setItems(prev => {
        const next = [...prev]
        if (appends % 30 === 0) {
          next.push({
            key: `live-new-${appends}`,
            lines: Array.from({ length: 3 }, (_, j) =>
              line(`LiveNew${appends}`, j),
            ),
          })
          return next
        }
        const last = next[next.length - 1]!
        next[next.length - 1] = {
          ...last,
          lines: [...last.lines, `Live stream ${appends}: arriving prose`],
        }
        return next
      })
    }, 33)
    return () => {
      clearInterval(spinner)
      clearInterval(growth)
    }
  }, [])
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
    </Box>
  )
}

describe('virtual scroll streaming invariants', () => {
  test('sticky streaming growth keeps layout and frame clean', () => {
    const stdout = fakeStdout()
    // Seed: SHORT content (10 items, ~22 rows) — under the 39-row
    // viewport, so the wrapper starts STRETCHED and the flexGrow spacer
    // carries real height. Growth then crosses the viewport boundary
    // (spacer shrinking to 0) — the transition where the e2e saw the
    // spacer/spinner layout overlap.
    let items: Item[] = Array.from({ length: 10 }, (_, i) => ({
      key: `seed-${i}`,
      lines: Array.from({ length: 2 + (i % 2) }, (_, j) => line(`Seed${i}`, j)),
    }))
    const instance = renderSync(<App items={items} tick={0} />, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const ink = instances.get(stdout) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: Parameters<typeof diffFrameAgainstReference>[1] }
      stylePool: Parameters<typeof diffFrameAgainstReference>[2]
    }
    const layoutViolations: string[] = []
    const renderDivergences: string[] = []
    try {
      const TICKS = 120
      for (let tick = 1; tick <= TICKS; tick++) {
        if (tick <= 40) {
          // Phase A — small arrivals crossing the viewport boundary
          // gradually: 3-line items appended one per frame.
          items = [
            ...items,
            {
              key: `batch-${tick}`,
              lines: Array.from({ length: 3 }, (_, j) =>
                line(`Batch${tick}`, j),
              ),
            },
          ]
        } else if (tick <= 100) {
          // Phase B — streaming: the tail item grows 2 lines per frame
          // (streams arrive in multi-row chunks), each growth frame
          // followed by a glyph-only settle frame.
          items = items.map((it, i) =>
            i === items.length - 1
              ? {
                  ...it,
                  lines: [
                    ...it.lines,
                    `Stream line ${tick}a: arriving prose`,
                    `Stream line ${tick}b: arriving prose`,
                  ],
                }
              : it,
          )
        }
        // Phase C (tick > 100) — glyph-only churn on static content,
        // like the spinner animating between monitor output rows.
        const frames: Array<() => void> = [
          () =>
            instance.rerender(
              <App items={items} tick={tick} />,
            ) /* growth + glyph */,
          ...(tick > 40 && tick <= 100
            ? [
                (): void =>
                  instance.rerender(
                    <App items={items} tick={tick + 500} />,
                  ) /* glyph-only settle (same items, new glyph) */,
              ]
            : []),
        ]
        for (const frame of frames) {
          frame()
          const found = checkLayoutInvariants(ink.rootNode)
          if (found.length > 0)
            layoutViolations.push(`tick ${tick}: ${found[0]}`)
          const mismatches = diffFrameAgainstReference(
            ink.rootNode,
            ink.frontFrame.screen,
            ink.stylePool,
          )
          if (mismatches.length > 0) {
            renderDivergences.push(
              `tick ${tick}: ${mismatches
                .slice(0, 4)
                .map(
                  m =>
                    `(${m.row},${m.col})${JSON.stringify(m.frameChar)}vs${JSON.stringify(m.referenceChar)}`,
                )
                .join(' ')}`,
            )
          }
        }
      }
      console.log(
        `layout violations at ${layoutViolations.length}/${TICKS} ticks; first: ${layoutViolations[0] ?? 'none'}`,
      )
      console.log(
        `render divergences at ${renderDivergences.length}/${TICKS} ticks; first: ${renderDivergences[0] ?? 'none'}`,
      )
      for (const l of layoutViolations.slice(0, 5)) console.log(`L: ${l}`)
      for (const r of renderDivergences.slice(0, 5)) console.log(`R: ${r}`)
      expect(layoutViolations.length).toBe(0)
      expect(renderDivergences.length).toBe(0)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })

  // The e2e's LAYOUT-CHECK overlap (flexGrow spacer vs spinner) fires on
  // the REAL app's async clocks: the spinner animates at 50ms via its
  // own subscription while content grows on stream timing, so commits
  // interleave in patterns a synchronous rerender loop can't produce.
  // Drive the same tree from two real timers and sample both checks
  // every 10ms — every frame (33ms+) is sampled several times.
  test('async-clocked streaming stays clean', async () => {
    const stdout = fakeStdout()
    const layoutViolations: string[] = []
    const renderDivergences: string[] = []
    let sampled = 0
    const instance = renderSync(<LiveApp />, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const ink = instances.get(stdout) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: Parameters<typeof diffFrameAgainstReference>[1] }
      stylePool: Parameters<typeof diffFrameAgainstReference>[2]
    }
    const sampler = setInterval(() => {
      sampled++
      const found = checkLayoutInvariants(ink.rootNode)
      if (found.length > 0 && layoutViolations.length < 5)
        layoutViolations.push(found[0]!)
      const mismatches = diffFrameAgainstReference(
        ink.rootNode,
        ink.frontFrame.screen,
        ink.stylePool,
      )
      if (mismatches.length > 0 && renderDivergences.length < 5) {
        renderDivergences.push(
          mismatches
            .slice(0, 4)
            .map(
              m =>
                `(${m.row},${m.col})${JSON.stringify(m.frameChar)}vs${JSON.stringify(m.referenceChar)}`,
            )
            .join(' '),
        )
      }
    }, 10)
    try {
      await new Promise(r => setTimeout(r, 4000))
      console.log(
        `sampled ${sampled}x; layout: ${layoutViolations.length ? layoutViolations[0] : 'none'}; render: ${renderDivergences.length ? renderDivergences[0] : 'none'}`,
      )
      expect(layoutViolations.length).toBe(0)
      expect(renderDivergences.length).toBe(0)
    } finally {
      clearInterval(sampler)
      instance.unmount()
      instance.cleanup()
    }
  })
})
