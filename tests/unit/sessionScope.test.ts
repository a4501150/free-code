import { describe, expect, test } from 'bun:test'
import {
  getSessionId,
  getCwdState,
  setCwdState,
  newSessionState,
  runInSessionScope,
  currentSessionState,
} from '../../src/bootstrap/state.js'
import {
  clearCommandQueue,
  dequeue,
  enqueue,
  getCommandQueueLength,
} from '../../src/utils/messageQueueManager.js'
import {
  getIsCompacting,
  setIsCompacting,
} from '../../src/utils/streamActivity.js'

/**
 * The session-scope layer: per-session state resolves against the active
 * scope, the root is untouched, and propagation survives awaits — the
 * invariant the multi-session server depends on.
 */
describe('session scope', () => {
  test('unscoped code resolves the root session state', () => {
    const root = currentSessionState()
    expect(getSessionId()).toBe(root.sessionId)
  })

  test('scoped code sees its own state, async boundaries included', async () => {
    const scopeA = newSessionState({ cwd: '/a' })
    const scopeB = newSessionState({ cwd: '/b' })

    const seen: Array<string | number> = []
    await runInSessionScope(scopeA, async () => {
      seen.push(getCwdState())
      setCwdState('/a2')
      // A scope survives an await and a nested other-scope run.
      await Promise.resolve()
      seen.push(getCwdState())
      await runInSessionScope(scopeB, async () => {
        seen.push(getCwdState())
        setCwdState('/b2')
      })
      seen.push(getCwdState())
    })

    expect(seen).toEqual(['/a', '/a2', '/b', '/a2'])
    // The scopes hold their own writes; the root never saw any of it.
    expect(scopeA.cwd).toBe('/a2')
    expect(scopeB.cwd).toBe('/b2')
    expect(scopeA.sessionId).not.toBe(scopeB.sessionId)
  })

  test('the command queue is per-scope', async () => {
    const scope = newSessionState()
    clearCommandQueue()

    runInSessionScope(scope, () => {
      enqueue({ value: 'scoped prompt', mode: 'prompt' })
      expect(getCommandQueueLength()).toBe(1)
    })
    // Outside the scope: the root queue never received it.
    expect(getCommandQueueLength()).toBe(0)
    expect(dequeue()).toBeUndefined()

    // And the scoped queue keeps its item across scopes.
    runInSessionScope(scope, () => {
      expect(getCommandQueueLength()).toBe(1)
      clearCommandQueue()
    })
  })

  test('stream activity is per-scope', async () => {
    const scope = newSessionState()
    setIsCompacting(false)

    runInSessionScope(scope, () => {
      setIsCompacting(true)
      expect(getIsCompacting()).toBe(true)
    })
    expect(getIsCompacting()).toBe(false)
  })
})
