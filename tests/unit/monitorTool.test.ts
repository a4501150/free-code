import { describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import { toolAlwaysAllowedRule } from '../../src/utils/permissions/permissions.js'
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

describe('MonitorTool permission rule delegation', () => {
  // permissionRuleToolName makes rules match under the Bash name: Monitor
  // is a facade over Bash permissions, so an allowlisted Bash covers it
  // and a Monitor-scoped rule matches nothing.
  const contextWithAllow = (allow: string[]) =>
    ({
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { userSettings: allow },
    }) as ToolPermissionContext

  test('a bare Bash allow rule covers Monitor', () => {
    expect(
      toolAlwaysAllowedRule(contextWithAllow(['Bash']), MonitorTool),
    ).not.toBeNull()
  })

  test('a bare Monitor rule matches nothing', () => {
    expect(
      toolAlwaysAllowedRule(contextWithAllow(['Monitor']), MonitorTool),
    ).toBeNull()
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
