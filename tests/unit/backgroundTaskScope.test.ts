import { describe, expect, test } from 'bun:test'
import { getScopedBackgroundTasks } from '../../src/state/agentViewHelpers.js'
import {
  makeLocalAgentTask,
  makeLocalShellTask,
} from '../helpers/taskFixtures.js'

describe('getScopedBackgroundTasks', () => {
  test('no agent view returns the task map unchanged', () => {
    const tasks = {
      b1: makeLocalShellTask({ id: 'b1' }),
      a1: makeLocalAgentTask({ id: 'a1' }),
    }
    expect(getScopedBackgroundTasks(tasks, undefined)).toBe(tasks)
  })

  test('agent view keeps the viewed agent’s own bash/monitor work only', () => {
    const tasks = {
      // parent-session bash — must drop out of the scoped view
      b_parent: makeLocalShellTask({ id: 'b_parent' }),
      // the viewed agent's bash and monitor (both local_bash)
      b_agent: makeLocalShellTask({ id: 'b_agent', agentId: 'a_view' }),
      m_agent: makeLocalShellTask({
        id: 'm_agent',
        agentId: 'a_view',
        kind: 'monitor',
      }),
      // another agent's bash — not ours
      b_other: makeLocalShellTask({ id: 'b_other', agentId: 'a2' }),
      // the viewed agent itself — excluded, its status lives in the panel
      a_view: makeLocalAgentTask({ id: 'a_view' }),
    }
    const scoped = getScopedBackgroundTasks(tasks, 'a_view')
    expect(Object.keys(scoped).sort()).toEqual(['b_agent', 'm_agent'])
  })

  test('agent view includes the viewed agent’s nested background agents', () => {
    const tasks = {
      a_view: makeLocalAgentTask({ id: 'a_view' }),
      a_nested: makeLocalAgentTask({ id: 'a_nested', parentAgentId: 'a_view' }),
      // sibling spawned by another agent — wrong parent
      a_sibling: makeLocalAgentTask({
        id: 'a_sibling',
        parentAgentId: 'a2',
      }),
      // legacy nested agent with no parentAgentId recorded
      a_legacy: makeLocalAgentTask({ id: 'a_legacy' }),
    }
    const scoped = getScopedBackgroundTasks(tasks, 'a_view')
    expect(Object.keys(scoped)).toEqual(['a_nested'])
  })

  test('a dangling view pointer (row evicted) does not narrow to nothing', () => {
    // The transcript/statusline surfaces degrade to "no agent view" when the
    // pointed row is gone; scoping must not keep hiding the session's own
    // background work behind the ghost id.
    const tasks = {
      b_parent: makeLocalShellTask({ id: 'b_parent' }),
      a_other: makeLocalAgentTask({ id: 'a_other' }),
    }
    expect(getScopedBackgroundTasks(tasks, 'a_evicted')).toBe(tasks)
  })
})
