import { describe, expect, test } from 'bun:test'
import { renderToolResultMessage } from '../../src/tools/BackgroundTaskListTool/BackgroundTaskListTool.js'
import { renderToString } from '../../src/utils/staticRender.js'

describe('BackgroundTaskListTool UI', () => {
  test('renders task counts in the standard tool-result gutter', async () => {
    const rendered = await renderToString(
      renderToolResultMessage({ count: 1, tasks: [] }),
    )

    expect(rendered).toBe('  ⎿ \u00a01 background task(s).')
  })

  test('renders the empty state in the standard tool-result gutter', async () => {
    const rendered = await renderToString(
      renderToolResultMessage({ count: 0, tasks: [] }),
    )

    expect(rendered).toBe('  ⎿ \u00a0No background tasks.')
  })
})
