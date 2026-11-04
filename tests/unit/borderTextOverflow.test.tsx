import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Box, Text } from '../../src/ink.js'
import {
  renderToAnsiString,
  renderToString,
} from '../../src/utils/staticRender.js'

// Content-sized box: inner content 'x'.repeat(10) makes the border line
// ╭ + 10×─ + ╮ = 12 display cells. The wrapper column with
// alignItems="flex-start" keeps the box from stretching to the stream width.
async function renderBorderBox(title: string, position: 'top' | 'bottom') {
  return renderToString(
    <Box flexDirection="column" alignItems="flex-start">
      <Box
        borderStyle="round"
        borderText={{ content: title, position, align: 'start', offset: 3 }}
      >
        <Text>{'x'.repeat(10)}</Text>
      </Box>
    </Box>,
  )
}

describe('borderText overflow', () => {
  test('long title keeps corner characters and truncates to the interior width', async () => {
    const rendered = await renderBorderBox('y'.repeat(30), 'top')
    const lines = rendered.split('\n').filter(l => l.length > 0)
    const top = lines[0]!

    expect(top.startsWith('╭')).toBe(true)
    expect(top.endsWith('╮')).toBe(true)
    // Row is exactly the border line width: corners + 10 interior cells
    expect(top).toBe(`╭${'y'.repeat(10)}╮`)
  })

  test('exact interior-width title fits with corners', async () => {
    const rendered = await renderBorderBox('y'.repeat(10), 'top')
    const top = rendered.split('\n')[0]!

    expect(top).toBe(`╭${'y'.repeat(10)}╮`)
  })

  test('overflowing ANSI-colored title keeps reset codes intact', async () => {
    const rendered = await renderToAnsiString(
      <Box flexDirection="column" alignItems="flex-start">
        <Box
          borderStyle="round"
          borderText={{
            content: `\x1b[35m${'y'.repeat(30)}\x1b[39m`,
            position: 'top',
            align: 'start',
            offset: 3,
          }}
        >
          <Text>{'x'.repeat(10)}</Text>
        </Box>
      </Box>,
    )
    const top = rendered.split('\n')[0]!

    // No escape sequence cut mid-way: the color run is closed by a reset
    // before the corner, and the row width matches the border line.
    expect(top).toContain('\x1b[39m')
    expect(top.endsWith('╮')).toBe(true)
  })

  test('bottom border text overflow keeps corners', async () => {
    const rendered = await renderBorderBox('y'.repeat(30), 'bottom')
    const lines = rendered.split('\n').filter(l => l.length > 0)
    const bottom = lines[lines.length - 1]!

    expect(bottom.startsWith('╰')).toBe(true)
    expect(bottom.endsWith('╯')).toBe(true)
    expect(bottom).toBe(`╰${'y'.repeat(10)}╯`)
  })

  test('short title still renders with border fill (regression)', async () => {
    const rendered = await renderBorderBox('Hi', 'top')
    const top = rendered.split('\n')[0]!

    expect(top).toBe(`╭───Hi─────╮`)
  })
})
