/**
 * Streaming-growth invariants for the scroll content, run through both
 * render diagnostics: a ScrollBox transcript (growing message + a
 * spinner row whose glyph and verb change every frame, mirroring REPL's
 * [messages..., flexGrow spacer, spinner] structure) must keep
 * non-absolute siblings non-overlapping beyond cover rounding, and the
 * incremental frame must match a cache-free reference render exactly.
 *
 * The e2e (render-invariant-checks.test.ts) sees two signatures on main
 * that this simplified structure does NOT reproduce — both depend on the
 * real transcript's virtual scroll (the documented useVirtualScroll
 * one-frame window lag): a 3-row message/spinner overlap during content
 * growth, and frame screens missing the viewport's edge rows. This test
 * is the floor: any regression reproducible WITHOUT virtual scroll
 * fails here in-process.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'

import { Box, Text } from '../../src/ink.js'
import ScrollBox from '../../src/ink/components/ScrollBox.js'
import { renderSync } from '../../src/ink/root.js'
import instances from '../../src/ink/instances.js'
import { checkLayoutInvariants } from '../../src/ink/layout-check.ts'
import { diffFrameAgainstReference } from '../../src/ink/render-check.ts'
import type { DOMElement } from '../../src/ink/dom.js'

function fakeStdout(columns = 80, rows = 24): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  Object.assign(stream, { columns, rows, isTTY: true })
  return stream
}

const GLYPHS = ['✻', '✽', '✶', '✳', '✢', '·']
const VERBS = ['Honking', 'Wandering', 'Ebbing', 'Pondering', 'Dreaming']

function App({ msgLines, tick }: { msgLines: string[]; tick: number }) {
  return (
    <Box flexDirection="column" height={20}>
      <ScrollBox flexGrow={1} stickyScroll>
        <Box flexDirection="column" width="100%">
          <Text>{msgLines[0]}</Text>
        </Box>
        <Box flexDirection="column" width="100%">
          {msgLines.slice(1).map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </Box>
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

describe('streaming layout repro', () => {
  test('appends keep siblings non-overlapping', () => {
    const stdout = fakeStdout()
    let msgLines = ['Batch line 0: seed']
    const instance = renderSync(<App msgLines={msgLines} tick={0} />, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const ink = instances.get(stdout) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: Parameters<typeof diffFrameAgainstReference>[1] }
      stylePool: Parameters<typeof diffFrameAgainstReference>[2]
    }
    const violations: string[] = []
    const renderDivergences: string[] = []
    try {
      for (let tick = 1; tick <= 40; tick++) {
        // Stream: append a line to the growing message AND rotate the
        // spinner glyph — both change in the same frame.
        msgLines = [
          ...msgLines,
          `Batch line ${tick}: some analysis prose that wraps across the width`,
        ]
        instance.rerender(<App msgLines={msgLines} tick={tick} />)
        const found = checkLayoutInvariants(ink.rootNode)
        if (found.length > 0) violations.push(`tick ${tick}: ${found[0]}`)
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
      console.log(
        `layout violations at ${violations.length}/40 ticks; first: ${violations[0] ?? 'none'}`,
      )
      console.log(
        `render divergences at ${renderDivergences.length}/40 ticks; first: ${renderDivergences[0] ?? 'none'}`,
      )
      expect(violations.length).toBe(0)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
