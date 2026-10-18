import { describe, expect, test } from 'bun:test'
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_ID_TAG,
  OUTPUT_FILE_TAG,
  TASK_TYPE_TAG,
} from '../../src/constants/xml.js'
import { renderTaskNotificationBlock } from '../../src/utils/task/notification.js'
import { extractTag } from '../../src/utils/messages.js'
import { getStatusColor } from '../../src/components/messages/UserAgentNotificationMessage.js'
import { buildMonitorNoticeText as buildMonitorNotice } from '../../src/tasks/MonitorTask/notifications.js'
import type { Monitor } from '../../src/utils/monitors.js'

function fakeMonitor(status: Monitor['status']): Monitor {
  return {
    id: 'mon_1_test',
    label: 'watch the deploy log',
    command: 'watch.sh',
    status,
    output: ['line'],
    newOutput: ['line'],
    hasUnnotifiedOutput: true,
  } as unknown as Monitor
}

function bulletColorFor(noticeText: string) {
  // Mirror the extraction UserAgentNotificationMessage performs.
  const status = extractTag(noticeText, STATUS_TAG)
  const taskType = extractTag(noticeText, TASK_TYPE_TAG)?.trim() ?? null
  return getStatusColor(status, taskType)
}

describe('monitor notification bullet color', () => {
  test('a statusless running-monitor ping renders with the success bullet', () => {
    const text = buildMonitorNotice([
      { monitor: fakeMonitor('running'), output: ['new line'] },
    ])
    expect(extractTag(text, STATUS_TAG)).toBeNull()
    expect(bulletColorFor(text)).toBe('success')
  })

  test('terminal monitor notices keep their status-driven colors', () => {
    expect(
      bulletColorFor(
        buildMonitorNotice([{ monitor: fakeMonitor('exited'), output: [] }]),
      ),
    ).toBe('success')
    expect(
      bulletColorFor(
        buildMonitorNotice([{ monitor: fakeMonitor('error'), output: [] }]),
      ),
    ).toBe('error')
    expect(
      bulletColorFor(
        buildMonitorNotice([{ monitor: fakeMonitor('stopped'), output: [] }]),
      ),
    ).toBe('warning')
  })

  test('a statusless notice without a monitor task-type stays neutral', () => {
    // The BashTool stall ping shape: wrapper with summary, no status, no task-type.
    const stall = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>b1a2c3d4</${TASK_ID_TAG}>
<${OUTPUT_FILE_TAG}>/tmp/b1a2c3d4.output</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>Background command "run installer" produced new output</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
Last output:
Proceed? [Y/n]`
    expect(bulletColorFor(stall)).toBe('text')
  })

  test('status-driven colors for non-monitor notices are unchanged', () => {
    for (const [status, color] of [
      ['completed', 'success'],
      ['failed', 'error'],
      ['killed', 'warning'],
    ] as const) {
      const text = renderTaskNotificationBlock({
        taskId: 'b1a2c3d4',
        status,
        summary: 'Background command finished',
      })
      expect(bulletColorFor(text)).toBe(color)
    }
  })
})
