import { describe, expect, test } from 'bun:test'

import {
  detectBlockingWait,
  isBlockingWait,
} from '../../src/utils/bash/sleepWait.js'

function topSeconds(command: string): number | undefined {
  return detectBlockingWait(command)?.topSleepSeconds
}

function flagged(command: string): boolean {
  return isBlockingWait(detectBlockingWait(command))
}

describe('detectBlockingWait: top-level sleeps', () => {
  test('literal sleep at or above the threshold is flagged', () => {
    expect(topSeconds('sleep 45')).toBe(45)
    expect(topSeconds('sleep 30')).toBe(30)
    expect(flagged('sleep 30')).toBe(true)
  })

  test('short sleeps are detected but not nudge-worthy', () => {
    // Rate-measurement probes (`sleep 20; du`) must stay under the bar.
    expect(topSeconds('sleep 20')).toBe(20)
    expect(flagged('sleep 20')).toBe(false)
    expect(flagged('sleep 20 && du -sb /tmp')).toBe(false)
  })

  test('duration suffixes and multiple arguments are summed', () => {
    expect(topSeconds('sleep 2m')).toBe(120)
    expect(topSeconds('sleep 1m 30')).toBe(90)
    expect(topSeconds('sleep 1.5h')).toBe(5400)
    expect(topSeconds('sleep 90s')).toBe(90)
    expect(topSeconds('sleep 1d')).toBe(86400)
  })

  test('infinity is always huge', () => {
    expect(topSeconds('sleep infinity')).toBe(Number.POSITIVE_INFINITY)
    expect(flagged('sleep infinity')).toBe(true)
  })

  test('quoted durations parse like bare ones', () => {
    expect(topSeconds('sleep "45"')).toBe(45)
  })

  test('sleep in a command chain is detected per statement', () => {
    // The observed escalation shape: `sleep 240; ps aux | grep ...`
    expect(topSeconds('sleep 240; ps aux | grep "[c]c1plus" | head -2')).toBe(
      240,
    )
    expect(
      topSeconds('du -sb /tmp > /tmp/a; sleep 20; du -sb /tmp > /tmp/b'),
    ).toBe(20)
    expect(
      flagged('du -sb /tmp > /tmp/a; sleep 20; du -sb /tmp > /tmp/b'),
    ).toBe(false)
  })

  test('dynamic duration is not counted as a top-level literal', () => {
    expect(topSeconds('sleep $WAIT_SECONDS')).toBeUndefined()
    expect(flagged('sleep $WAIT_SECONDS')).toBe(false)
  })

  test('env-var prefix is transparent', () => {
    expect(topSeconds('SILENT=1 sleep 45')).toBe(45)
  })
})

describe('detectBlockingWait: exclusions', () => {
  test('sleep nested in bash -c / setsid arguments is not the outer command', () => {
    // Background launcher shapes from the live transcript: the sleep lives
    // inside a quoted script handed to another interpreter/process.
    expect(
      topSeconds(
        `setsid -f bash -c 'for i in 1 2 3; do hf download x && exit 0; sleep 10; done' > log 2>&1`,
      ),
    ).toBeUndefined()
    expect(topSeconds(`bash -c 'sleep 60'`)).toBeUndefined()
  })

  test('backgrounded sleep does not block the foreground call', () => {
    expect(topSeconds('sleep 60 & sleep 45')).toBe(45)
    expect(topSeconds('sleep 60 &')).toBeUndefined()
    expect(topSeconds('sleep 90 && tail -1 log & echo started')).toBeUndefined()
    expect(topSeconds('du -sb . > a; sleep 45 & du -sb . > b')).toBeUndefined()
  })

  test('sleep inside a function definition is not executed', () => {
    expect(topSeconds('wait_a_bit() { sleep 60; }; wait_a_bit')).toBeUndefined()
  })

  test('plain tail is a peek, tail -f is a follow', () => {
    expect(flagged('tail -3 /tmp/build.log')).toBe(false)
    expect(flagged('tail -f /tmp/build.log')).toBe(true)
    expect(flagged('tail --follow=name /tmp/build.log')).toBe(true)
    expect(flagged('tail -F /tmp/build.log')).toBe(true)
  })
})

describe('detectBlockingWait: loop bodies', () => {
  test('a sleep of any duration inside a loop is a poll', () => {
    expect(flagged('while ! grep -q DONE log; do sleep 5; done')).toBe(true)
    expect(flagged('until grep -q DONE log; do sleep 1; done')).toBe(true)
    expect(flagged('for i in 1 2 3; do sleep 10; done')).toBe(true)
  })

  test('loop detection survives redirects and subshells around the loop', () => {
    expect(
      flagged('while ps -p 1 >/dev/null; do sleep 2; done | head -1'),
    ).toBe(true)
  })

  test('dynamic loop sleep still counts', () => {
    expect(flagged('while :; do sleep $POLL; done')).toBe(true)
  })

  test('a loop without a sleep is not flagged', () => {
    expect(flagged('while ! grep -q DONE log; do wc -c log; done')).toBe(false)
  })
})

describe('detectBlockingWait: misc shapes', () => {
  test('unparseable command returns null, not an error', () => {
    expect(detectBlockingWait('')).toBeNull()
  })

  test('command substitution sleep blocks and is detected', () => {
    expect(topSeconds('echo "$(sleep 45)"')).toBe(45)
  })

  test('no sleep at all returns null', () => {
    expect(detectBlockingWait('cargo build --release')).toBeNull()
  })
})
