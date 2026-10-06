import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  MonitorManager,
  type KillFn,
  type SpawnFn,
} from '../../src/utils/monitors.js'
import type { AgentId } from '../../src/types/ids.js'
import { buildMonitorNoticeText } from '../../src/tasks/MonitorTask/notifications.js'

// ---------------------------------------------------------------------------
// Test doubles: injectable spawn/kill keep the suite hermetic (unit tests
// share one process, so mock.module is off-limits — see AGENTS.md). Fake
// children are EventEmitters with real PassThrough streams so the
// readline interfaces exercise real line-splitting.
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 42
  killSignal: string | null = null

  constructor() {
    super()
    // node:child_process children are EventEmitters; the manager listens
    // for 'exit' and 'error'.
  }
}

function fakeChild(): FakeChildProcess {
  return new FakeChildProcess()
}

const noopKill: KillFn = _pid => {}

function makeManager(
  child: FakeChildProcess,
  options: {
    debounceMs?: number
    onOutput?: () => void
    kills?: number[]
  } = {},
): MonitorManager {
  const spawnFn: SpawnFn = _command => child as unknown as ChildProcess
  const killFn: KillFn = (pid, cb) => {
    options.kills?.push(pid)
    cb()
  }
  const manager = new MonitorManager({
    spawnFn,
    killFn,
    debounceMs: options.debounceMs ?? 10,
    attachExitHook: false,
  })
  if (options.onOutput) {
    manager.onOutput(options.onOutput)
  }
  return manager
}

/** Emit a stdout line (with newline, like a real pipe). */
async function emitStdout(
  child: FakeChildProcess,
  line: string,
): Promise<void> {
  child.stdout.write(`${line}\n`)
  // Let readline's async line events settle.
  await new Promise(r => setTimeout(r, 10))
}

describe('MonitorManager', () => {
  test('starts a monitor and assigns an id', () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('tail -f app.log', 'app-log-tail')
    expect(monitor.id).toMatch(/^mon_\d+_/)
    expect(monitor.label).toBe('app-log-tail')
    expect(monitor.command).toBe('tail -f app.log')
    expect(monitor.status).toBe('running')
    expect(manager.activeCount).toBe(1)
  })

  test('captures stdout lines as output', async () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('echo', 'e')
    await emitStdout(
      manager.get(monitor.id)!.child as FakeChildProcess,
      'hello',
    )
    expect(monitor.output).toEqual(['hello'])
    expect(monitor.newOutput).toEqual(['hello'])
    expect(monitor.hasUnnotifiedOutput).toBe(true)
  })

  test('captures stderr lines as output', async () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    const child = monitor.child as unknown as FakeChildProcess
    child.stderr.write('warning\n')
    await new Promise(r => setTimeout(r, 10))
    expect(monitor.output).toEqual(['warning'])
  })

  test('marks monitor as exited on child exit', async () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    ;(monitor.child as unknown as FakeChildProcess).emit('exit', 0)
    expect(monitor.status).toBe('exited')
    expect(monitor.exitCode).toBe(0)
    expect(manager.activeCount).toBe(0)
  })

  test('marks monitor as error on non-zero exit', () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    ;(monitor.child as unknown as FakeChildProcess).emit('exit', 1)
    expect(monitor.status).toBe('error')
    expect(monitor.exitCode).toBe(1)
  })

  test('marks monitor as error on child error event', () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    ;(monitor.child as unknown as FakeChildProcess).emit(
      'error',
      new Error('spawn failed'),
    )
    expect(monitor.status).toBe('error')
    expect(monitor.newOutput).toContain('[monitor error: spawn failed]')
  })

  test('a spawn throw is reported through the monitor, not thrown', () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('ENOENT')
    }
    const manager = new MonitorManager({
      spawnFn,
      killFn: noopKill,
      attachExitHook: false,
    })
    const monitor = manager.start('nonexistent', 'e')
    expect(monitor.status).toBe('error')
    expect(monitor.newOutput[0]).toContain('[failed to start: ENOENT]')
  })

  test('stops a running monitor and kills the process', () => {
    const child = fakeChild()
    const kills: number[] = []
    const manager = makeManager(child, { kills })
    const monitor = manager.start('tail -f log', 'l')
    expect(manager.stop(monitor.id)).toBe(true)
    expect(monitor.status).toBe('stopped')
    expect(monitor.newOutput).toContain('[monitor stopped by model]')
    expect(kills).toEqual([child.pid])
    // A late exit event must not overwrite the 'stopped' status.
    child.emit('exit', 1)
    expect(monitor.status).toBe('stopped')
  })

  test('stop returns false for non-existent monitor', () => {
    const manager = makeManager(fakeChild())
    expect(manager.stop('mon_missing')).toBe(false)
  })

  test('stop returns false for already-stopped monitor', () => {
    const child = fakeChild()
    const manager = makeManager(child)
    const monitor = manager.start('cmd', 'e')
    child.emit('exit', 0)
    expect(manager.stop(monitor.id)).toBe(false)
  })

  test('get returns monitor by id', () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    expect(manager.get(monitor.id)?.id).toBe(monitor.id)
    expect(manager.get('mon_missing')).toBeUndefined()
  })

  test('takeUnnotifiedOutput returns new output and clears the flag', async () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    await emitStdout(monitor.child as FakeChildProcess, 'line-1')
    const entries = manager.takeUnnotifiedOutput()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.output).toEqual(['line-1'])
    expect(monitor.hasUnnotifiedOutput).toBe(false)
    expect(monitor.newOutput).toEqual([])
    expect(manager.takeUnnotifiedOutput()).toEqual([])
  })

  test('takeUnnotifiedOutput respects the predicate (per-agent notices)', async () => {
    const children = [fakeChild(), fakeChild()]
    const spawnQueue = [...children]
    const spawnFn: SpawnFn = () => spawnQueue.shift() as unknown as ChildProcess
    const manager = new MonitorManager({
      spawnFn,
      killFn: noopKill,
      attachExitHook: false,
    })
    const main = manager.start('cmd', 'main-monitor')
    const sub = manager.start('cmd', 'sub-monitor', {
      agentId: 'agent-1' as AgentId,
    })
    await emitStdout(children[0]!, 'from-main')
    await emitStdout(children[1]!, 'from-sub')
    const subEntries = manager.takeUnnotifiedOutput(
      m => m.agentId === 'agent-1',
    )
    expect(subEntries).toHaveLength(1)
    expect(subEntries[0]!.output).toEqual(['from-sub'])
    // Main-thread output is untouched by the subagent take.
    expect(main.hasUnnotifiedOutput).toBe(true)
    const mainEntries = manager.takeUnnotifiedOutput(m => !m.agentId)
    expect(mainEntries).toHaveLength(1)
    expect(mainEntries[0]!.output).toEqual(['from-main'])
  })

  test('rolling buffer trims old output beyond max', async () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    const child = monitor.child as FakeChildProcess
    for (let i = 0; i < 205; i++) {
      child.stdout.write(`line-${i}\n`)
      // Small batches so the rolling splice keeps the buffer bounded.
      if (i % 50 === 0) await new Promise(r => setTimeout(r, 15))
    }
    await new Promise(r => setTimeout(r, 60))
    expect(monitor.output.length).toBeLessThanOrEqual(200)
    expect(monitor.output[monitor.output.length - 1]).toContain('line-204')
  })

  test('truncates very long lines', async () => {
    const manager = makeManager(fakeChild())
    const monitor = manager.start('cmd', 'e')
    await emitStdout(monitor.child as FakeChildProcess, 'x'.repeat(2000))
    expect(monitor.output[0]!.length).toBeLessThanOrEqual(1020)
    expect(monitor.output[0]).toContain('[truncated]')
  })

  test('hasUnnotifiedOutput tracks pending output', async () => {
    const manager = makeManager(fakeChild())
    expect(manager.hasUnnotifiedOutput()).toBe(false)
    const monitor = manager.start('cmd', 'e')
    await emitStdout(monitor.child as FakeChildProcess, 'hi')
    expect(manager.hasUnnotifiedOutput()).toBe(true)
    manager.takeUnnotifiedOutput()
    expect(manager.hasUnnotifiedOutput()).toBe(false)
  })

  test('stopAll stops all running monitors and detaches the trigger', () => {
    const child1 = fakeChild()
    const child2 = fakeChild()
    const kills: number[] = []
    let triggers = 0
    const spawnQueue = [child1, child2]
    const spawnFn: SpawnFn = () => spawnQueue.shift() as unknown as ChildProcess
    const killFn: KillFn = (pid, cb) => {
      kills.push(pid)
      cb()
    }
    const manager = new MonitorManager({
      spawnFn,
      killFn,
      debounceMs: 10,
      attachExitHook: false,
    })
    manager.onOutput(() => triggers++)
    manager.start('one', '1')
    manager.start('two', '2')
    expect(manager.activeCount).toBe(2)
    manager.stopAll()
    expect(manager.activeCount).toBe(0)
    expect(kills).toEqual([child1.pid, child2.pid])
    // The auto-trigger is detached: further output must not fire callbacks.
    child1.stdout.write('late\n')
    child2.emit('exit', 0)
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(triggers).toBe(0)
        resolve()
      }, 40)
    })
  })

  test('activeCount only counts running monitors', () => {
    const spawnQueue = [fakeChild(), fakeChild()]
    const spawnFn: SpawnFn = () => spawnQueue.shift() as unknown as ChildProcess
    const manager = new MonitorManager({
      spawnFn,
      killFn: noopKill,
      attachExitHook: false,
    })
    manager.start('one', '1')
    const m2 = manager.start('two', '2')
    // Kill the second monitor's child: only m2 sees this exit event.
    ;(m2.child as unknown as FakeChildProcess).emit('exit', 0)
    expect(manager.activeCount).toBe(1)
  })

  test('output callback is debounced', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      debounceMs: 30,
      onOutput: () => triggers++,
    })
    const monitor = manager.start('cmd', 'e')
    for (let i = 0; i < 5; i++) {
      child.stdout.write(`line-${i}\n`)
    }
    await new Promise(r => setTimeout(r, 10))
    expect(triggers).toBe(0) // still inside the debounce window
    await new Promise(r => setTimeout(r, 40))
    expect(triggers).toBe(1) // one trigger for the whole burst
    void monitor
  })

  test('identical consecutive lines do not re-trigger after a notice', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      debounceMs: 10,
      onOutput: () => triggers++,
    })
    const monitor = manager.start('poll', 'p')
    await emitStdout(child, 'CI=pending')
    await new Promise(r => setTimeout(r, 30))
    expect(triggers).toBe(1)
    manager.takeUnnotifiedOutput() // advances the suppression marker

    await emitStdout(child, 'CI=pending')
    await emitStdout(child, 'CI=pending')
    await new Promise(r => setTimeout(r, 40))
    expect(triggers).toBe(1) // no new trigger for identical lines

    await emitStdout(child, 'CI=failed')
    await new Promise(r => setTimeout(r, 40))
    expect(triggers).toBe(2) // a changed line re-triggers
    void monitor
  })

  test('monitor exit always triggers, even without output', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      debounceMs: 10,
      onOutput: () => triggers++,
    })
    const monitor = manager.start('cmd', 'e')
    child.emit('exit', 0)
    await new Promise(r => setTimeout(r, 30))
    expect(triggers).toBe(1)
    expect(monitor.status).toBe('exited')
    expect(manager.hasUnnotifiedOutput()).toBe(true)
  })

  test('per-monitor notifyIntervalMs gates the change trigger', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      debounceMs: 10,
      onOutput: () => triggers++,
    })
    const monitor = manager.start('cmd', 'e', { notifyIntervalMs: 80 })
    await emitStdout(child, 'line-1')
    await new Promise(r => setTimeout(r, 30))
    expect(triggers).toBe(0) // still inside the 80ms monitor window
    await new Promise(r => setTimeout(r, 80))
    expect(triggers).toBe(1)
    void monitor
  })

  test('per-monitor interval still respects identical-line suppression', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      onOutput: () => triggers++,
    })
    const monitor = manager.start('poll', 'p', { notifyIntervalMs: 20 })
    await emitStdout(child, 'CI=pending')
    await new Promise(r => setTimeout(r, 40))
    expect(triggers).toBe(1)
    manager.takeUnnotifiedOutput() // advances the suppression marker

    await emitStdout(child, 'CI=pending')
    await new Promise(r => setTimeout(r, 60))
    expect(triggers).toBe(1) // identical line: silent even after the window
    void monitor
  })

  test('terminal transitions flush immediately, bypassing the notify interval', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      onOutput: () => triggers++,
    })
    const monitor = manager.start('cmd', 'e', { notifyIntervalMs: 60_000 })
    child.emit('exit', 0)
    await new Promise(r => setTimeout(r, 30))
    expect(triggers).toBe(1) // exit notice not delayed by the 60s window
    expect(monitor.status).toBe('exited')

    // stop() flushes the same way.
    let stopTriggers = 0
    const child2 = fakeChild()
    const manager2 = makeManager(child2, {
      onOutput: () => stopTriggers++,
    })
    const monitor2 = manager2.start('cmd', 'e', { notifyIntervalMs: 60_000 })
    manager2.stop(monitor2.id)
    await new Promise(r => setTimeout(r, 30))
    expect(stopTriggers).toBe(1)
  })

  test('stopAll clears pending per-monitor debounce timers', async () => {
    let triggers = 0
    const child = fakeChild()
    const manager = makeManager(child, {
      onOutput: () => triggers++,
    })
    manager.start('cmd', 'e', { notifyIntervalMs: 20 })
    await emitStdout(child, 'line-1')
    manager.stopAll()
    await new Promise(r => setTimeout(r, 60))
    expect(triggers).toBe(0) // the pending window died with the manager
  })

  test('onLine fires per stream line and for the synthetic stop line', async () => {
    const child = fakeChild()
    const manager = makeManager(child)
    const lines: string[] = []
    manager.onLine((_monitor, line) => lines.push(line))
    const monitor = manager.start('cmd', 'e')
    await emitStdout(child, 'hello')
    expect(lines).toEqual(['hello'])
    manager.stop(monitor.id)
    expect(lines).toEqual(['hello', '[monitor stopped by model]'])
  })

  test('onStatusChange fires on exit and on stop', () => {
    const child = fakeChild()
    const manager = makeManager(child)
    const statuses: string[] = []
    manager.onStatusChange(m => statuses.push(m.status))
    const monitor = manager.start('cmd', 'e')
    child.emit('exit', 0)
    expect(statuses).toEqual(['exited'])

    const child2 = fakeChild()
    const manager2 = makeManager(child2)
    const statuses2: string[] = []
    manager2.onStatusChange(m => statuses2.push(m.status))
    const monitor2 = manager2.start('cmd', 'e')
    manager2.stop(monitor2.id)
    expect(statuses2).toEqual(['stopped'])
  })

  test('onStatusChange fires when a spawn throws', () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('ENOENT')
    }
    const manager = new MonitorManager({
      spawnFn,
      killFn: noopKill,
      attachExitHook: false,
    })
    const statuses: string[] = []
    manager.onStatusChange(m => statuses.push(m.status))
    manager.start('nonexistent', 'e')
    expect(statuses).toEqual(['error'])
  })

  test('stopAll detaches onLine and onStatusChange', async () => {
    const child = fakeChild()
    const manager = makeManager(child)
    let lines = 0
    let statusChanges = 0
    manager.onLine(() => lines++)
    manager.onStatusChange(() => statusChanges++)
    const monitor = manager.start('cmd', 'e')
    manager.stopAll()
    // stopAll kills and transitions without firing the hooks (cleared first).
    expect(statusChanges).toBe(0)
    expect(monitor.status).toBe('stopped')
    child.stdout.write('late\n')
    await new Promise(r => setTimeout(r, 20))
    expect(lines).toBe(0)
  })
})

describe('buildMonitorNoticeText', () => {
  test('renders a running monitor as a statusless task-notification', () => {
    const manager = new MonitorManager({
      spawnFn: () => fakeChild() as unknown as ChildProcess,
      killFn: noopKill,
      attachExitHook: false,
    })
    const m = manager.start('cmd', 'ci-poll')
    m.newOutput.push('CI=failed', 'build 1234')
    m.hasUnnotifiedOutput = true

    const text = buildMonitorNoticeText([
      { monitor: m, output: ['CI=failed', 'build 1234'] },
    ])
    // Tag-first so the prefix-anchored synthetic routing in UserTextMessage
    // classifies it.
    expect(text.startsWith('<task-notification>')).toBe(true)
    expect(text).toContain('<task-id>mon_1_')
    expect(text).toContain('<task-type>monitor</task-type>')
    expect(text).toContain('<output-file>')
    expect(text).toContain(
      '<summary>Background monitor "ci-poll" produced new output</summary>',
    )
    expect(text).toContain('<monitor-output>')
    expect(text).toContain('CI=failed')
    expect(text).toContain('build 1234')
    // Statusless while running — print.ts treats <status> as terminal.
    expect(text).not.toContain('<status>')
  })

  test('renders (no output) for empty output', () => {
    const manager = new MonitorManager({
      spawnFn: () => fakeChild() as unknown as ChildProcess,
      killFn: noopKill,
      attachExitHook: false,
    })
    const m = manager.start('cmd', 'quiet')
    const text = buildMonitorNoticeText([{ monitor: m, output: [] }])
    expect(text).toContain('(no output)')
  })

  test('renders a terminal monitor with a mapped status and summary', () => {
    const manager = new MonitorManager({
      spawnFn: () => fakeChild() as unknown as ChildProcess,
      killFn: noopKill,
      attachExitHook: false,
    })
    const m = manager.start('cmd', 'ci-poll')
    m.status = 'exited'
    m.exitCode = 0

    const text = buildMonitorNoticeText([{ monitor: m, output: [] }])
    expect(text).toContain('<status>completed</status>')
    expect(text).toContain(
      '<summary>Background monitor "ci-poll" completed (exit code 0)</summary>',
    )
  })
})
