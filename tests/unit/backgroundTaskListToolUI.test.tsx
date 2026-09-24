import { describe, expect, test } from 'bun:test'
import { renderToolResultMessage } from '../../src/tools/BackgroundTaskListTool/BackgroundTaskListTool.js'
import { renderToString } from '../../src/utils/staticRender.js'

describe('BackgroundTaskListTool UI', () => {
  test('renders one row per task with status, kind and description', async () => {
    const rendered = await renderToString(
      renderToolResultMessage({
        count: 2,
        tasks: [
          {
            task_id: 'abc12345',
            task_type: 'local_bash',
            status: 'running',
            description: 'run the suite',
            start_time: 1,
            output_file: '/tmp/abc12345.output',
          },
          {
            task_id: 'def67890',
            task_type: 'local_agent',
            status: 'completed',
            description: 'research the API',
            start_time: 1,
            end_time: 2,
            output_file: '/tmp/def67890.output',
            agent_type: 'general-purpose',
          },
        ],
      }),
    )

    // staticRender lays out at a fixed terminal width, so long rows wrap;
    // assert the stable per-row prefixes and detail fragments.
    expect(rendered).toContain('[running] bash')
    expect(rendered).toContain('[completed] agent')
    expect(rendered).toContain('general-purpose')
  })

  test('renders the empty state in the standard tool-result gutter', async () => {
    const rendered = await renderToString(
      renderToolResultMessage({ count: 0, tasks: [] }),
    )

    expect(rendered).toBe('  ⎿ \u00a0No background tasks.')
  })
})
