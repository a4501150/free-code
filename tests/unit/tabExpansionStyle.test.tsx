import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { Text } from '../../src/ink.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'

// The runner is not a TTY, so chalk defaults to level 0 and every render below
// would come back as plain text with the assertions passing vacuously. chalk is
// a mutable singleton, so set the level directly — FORCE_COLOR is latched at
// import time and whichever test file loaded chalk first wins.
const originalLevel = chalk.level
beforeAll(() => {
  chalk.level = 3
})
afterAll(() => {
  chalk.level = originalLevel
})

describe('tab expansion', () => {
  test('expanded spaces inherit the surrounding background', async () => {
    const rendered = await renderToAnsiString(
      <Text backgroundColor="error">127G{'\t'}ravermap/</Text>,
    )

    // One unbroken background run. Before the fix the spaces were written with
    // stylePool.none, closing the background (\u001b[49m) across the gap, which
    // punched a hole through tab-separated output such as `du -sh`.
    expect(rendered).toBe('\u001b[48;2;255;107;128m127G    ravermap/\u001b[49m')
  })

  test('expanded spaces inherit inverse video', async () => {
    const rendered = await renderToAnsiString(
      <Text inverse>127G{'\t'}ravermap/</Text>,
    )

    expect(rendered).toBe('\u001b[7m127G    ravermap/\u001b[27m')
  })

  test('tabs still advance to the next 8-column stop', async () => {
    const rendered = await renderToAnsiString(<Text>ab{'\t'}c</Text>)

    expect(rendered).toBe('ab      c')
  })
})
