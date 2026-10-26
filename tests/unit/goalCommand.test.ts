/**
 * /goal rides the session-hook registry: setting registers a prompt-type Stop
 * hook, the evaluator's success result auto-clears it, and /goal clear removes
 * it manually.
 */
import { describe, expect, test } from 'bun:test'
import { call } from '../../src/commands/goal/goal.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../src/types/command.js'

function makeContext(): {
  appState: AppState
  context: LocalJSXCommandContext
} {
  const appState = {
    sessionHooks: new Map(),
  } as unknown as AppState
  const setAppState = (f: (prev: AppState) => AppState): void => {
    Object.assign(appState, f(appState))
  }
  const context = {
    getAppState: () => appState,
    setAppState,
  } as unknown as LocalJSXCommandContext
  return { appState, context }
}

function goalHooksFor(appState: AppState): Array<{
  hook: { type: string; prompt?: string }
  onHookSuccess?: (hook: unknown, result: unknown) => void
}> {
  const store = appState.sessionHooks.get(getSessionId())
  const matchers = store?.hooks['Stop'] ?? []
  return matchers.flatMap(m =>
    m.hooks.map(h => ({
      hook: h.hook as unknown as { type: string; prompt?: string },
      onHookSuccess: h.onHookSuccess,
    })),
  )
}

describe('/goal', () => {
  test('set registers a prompt Stop hook and records the goal', async () => {
    const { appState, context } = makeContext()
    let doneMsg = ''
    let doneOpts: { shouldQuery?: boolean; metaMessages?: string[] } | undefined
    await call(
      (msg, opts) => {
        doneMsg = msg ?? ''
        doneOpts = opts
      },
      context,
      'make all tests pass',
    )
    expect(doneMsg).toBe('Goal set: make all tests pass')
    expect(doneOpts?.shouldQuery).toBe(true)
    expect(doneOpts?.metaMessages?.[0]).toContain('Stop hook')
    expect(appState.activeGoal?.condition).toBe('make all tests pass')
    const hooks = goalHooksFor(appState)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.hook).toEqual({
      type: 'prompt',
      prompt: 'make all tests pass',
      statusMessage: 'Checking goal',
    })
  })

  test('evaluator success auto-clears the goal and the hook', async () => {
    const { appState, context } = makeContext()
    const onDone = () => {}
    await call(onDone, context, 'ship it')
    const hookEntry = goalHooksFor(appState)[0]!
    expect(hookEntry.onHookSuccess).toBeDefined()
    hookEntry.onHookSuccess!(hookEntry.hook, {})
    expect(appState.activeGoal).toBeUndefined()
    expect(goalHooksFor(appState)).toHaveLength(0)
  })

  test('clear removes the hook and state', async () => {
    const { appState, context } = makeContext()
    const onDone = () => {}
    await call(onDone, context, 'ship it')
    let doneMsg = ''
    await call(
      msg => {
        doneMsg = msg ?? ''
      },
      context,
      'clear',
    )
    expect(doneMsg).toBe('Goal cleared: ship it')
    expect(appState.activeGoal).toBeUndefined()
    expect(goalHooksFor(appState)).toHaveLength(0)
  })

  test('setting a second goal replaces the first hook', async () => {
    const { appState, context } = makeContext()
    const onDone = () => {}
    await call(onDone, context, 'first')
    await call(onDone, context, 'second')
    expect(appState.activeGoal?.condition).toBe('second')
    const hooks = goalHooksFor(appState)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.hook.prompt).toBe('second')
  })

  test('bare /goal reports the active goal', async () => {
    const { context } = makeContext()
    await call(() => {}, context, 'do the thing')
    let doneMsg = ''
    await call(
      msg => {
        doneMsg = msg ?? ''
      },
      context,
      '',
    )
    expect(doneMsg).toContain('Active goal: do the thing')
  })
})
