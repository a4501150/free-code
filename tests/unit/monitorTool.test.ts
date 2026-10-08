import { describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import { MonitorTool } from '../../src/tools/MonitorTool/MonitorTool.js'
import type { MonitorToolInput } from '../../src/tools/MonitorTool/MonitorTool.js'

const INPUT: MonitorToolInput = {
  command: 'ls',
  description: 'probe',
  notify_interval: '5s',
}

function context() {
  return {
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never
}

describe('MonitorTool.checkPermissions', () => {
  // bashToolHasPermission echoes its (narrowed, command-only) argument back
  // as updatedInput on allow branches, and the executor adopts updatedInput
  // as the input for call(). Without the re-attach, call() would receive
  // {command} and fail to parse notify_interval.
  test('allow decision re-attaches the full Monitor input', async () => {
    const result = await MonitorTool.checkPermissions(INPUT, context())
    expect(result.behavior).toBe('allow')
    if ('updatedInput' in result) {
      expect(result.updatedInput).toEqual(INPUT)
    } else {
      throw new Error('allow decision must carry updatedInput')
    }
  })
})

describe('MonitorTool.validateInput', () => {
  test('accepts a parseable notify_interval', async () => {
    const result = await MonitorTool.validateInput?.(INPUT, context())
    expect(result?.result).toBe(true)
  })

  test('rejects an unparseable notify_interval with the format hint', async () => {
    const result = await MonitorTool.validateInput?.(
      { ...INPUT, notify_interval: 'soon' },
      context(),
    )
    expect(result?.result).toBe(false)
    expect((result as { message?: string }).message).toContain(
      'notify_interval',
    )
  })
})
