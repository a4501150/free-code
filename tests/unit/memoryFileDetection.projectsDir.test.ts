import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// The config home is memoized keyed on the env vars, so setting it here
// before the module is first exercised pins it for these tests.
const previous = process.env.FREECODE_CONFIG_DIR
let mod: typeof import('../../src/utils/memoryFileDetection.js')

beforeAll(async () => {
  process.env.FREECODE_CONFIG_DIR = '/test-home/.freecode'
  mod = await import('../../src/utils/memoryFileDetection.js')
})

afterAll(() => {
  if (previous === undefined) {
    delete process.env.FREECODE_CONFIG_DIR
  } else {
    process.env.FREECODE_CONFIG_DIR = previous
  }
})

describe('isMemoryDirectory under <config>/projects/', () => {
  test('counts the slug and session levels as memory', () => {
    expect(mod.isMemoryDirectory('/test-home/.freecode/projects/-proj-a')).toBe(
      true,
    )
    expect(
      mod.isMemoryDirectory('/test-home/.freecode/projects/-proj-a/sess-1'),
    ).toBe(true)
  })

  test('does not count deeper session plumbing directories', () => {
    // Regressed: a grep over a spilled tool-result file rendered as
    // "Searched memories for <the grep command itself>".
    expect(
      mod.isMemoryDirectory(
        '/test-home/.freecode/projects/-proj-a/sess-1/tool-results',
      ),
    ).toBe(false)
    expect(
      mod.isMemoryDirectory(
        '/test-home/.freecode/projects/-proj-a/sess-1/subagents',
      ),
    ).toBe(false)
  })

  test('still counts the auto-memory directory under a sibling slug', () => {
    expect(
      mod.isMemoryDirectory('/test-home/.freecode/projects/-proj-b/memory'),
    ).toBe(true)
  })
})

describe('isShellCommandTargetingMemory', () => {
  test('a grep over a session tool-results file is not a memory search', () => {
    expect(
      mod.isShellCommandTargetingMemory(
        "grep -n 'function' /test-home/.freecode/projects/-proj-a/sess-1/tool-results/abc.txt",
      ),
    ).toBe(false)
  })

  test('a grep over the session directory still is', () => {
    expect(
      mod.isShellCommandTargetingMemory(
        "grep -rn 'pattern' /test-home/.freecode/projects/-proj-a/sess-1",
      ),
    ).toBe(true)
  })
})
