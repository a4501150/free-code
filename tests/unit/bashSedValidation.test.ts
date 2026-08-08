import { describe, expect, test } from 'bun:test'

import {
  checkSedConstraints,
  extractSedExpressions,
  hasFileArgs,
  sedCommandIsAllowedByAllowlist,
} from '../../src/tools/BashTool/sedValidation.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../src/Tool.js'
import {
  parseForSecurity,
  type SimpleCommand,
} from '../../src/utils/bash/ast.js'

function commands(command: string): SimpleCommand[] {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple') throw new Error(`not simple: ${command}`)
  return parsed.commands
}

function allowed(command: string, allowFileWrites = false): boolean {
  const cmd = commands(command)[0]
  return cmd ? sedCommandIsAllowedByAllowlist(cmd, { allowFileWrites }) : false
}

describe('sed allowlist reads resolved argv', () => {
  const table: Array<[string, boolean]> = [
    // Pattern 1: line printing with -n. File arguments are allowed.
    ["sed -n '1,10p' file.txt", true],
    ["sed -n '1p;2p;3p' file.txt", true],
    ["sed -n 'p' file.txt", true],
    ["sed -nE '1,5p' file.txt", true],
    // Pattern 2: substitution, stdout only.
    ["sed 's/a/b/g'", true],
    ["sed -E 's/a+/b/'", true],
    ["sed 's/a/b/' file.txt", false],
    // Write and execute commands are refused in every form.
    ["sed -n '1,10w /tmp/out' file.txt", false],
    ["sed 's/a/b/w /tmp/x'", false],
    ["sed 's/a/b/e'", false],
    ["sed -n '1,10W /tmp/out' f", false],
    // Non-slash delimiters are refused.
    ["sed 's|a|b|'", false],
    // Unknown flags are refused.
    ["sed -i 's/a/b/' file.txt", false],
    ["sed --expression='1,5p' -n f.txt", false],
    // A dangerous combined flag is refused before flag validation.
    ["sed -ew 'x'", false],
    // Semicolons separate commands and are only allowed for print patterns.
    ["sed 's/a/b/;s/c/d/'", false],
  ]

  for (const [command, want] of table) {
    test(`${want ? 'allows' : 'refuses'} ${command}`, () => {
      expect(allowed(command)).toBe(want)
    })
  }

  test('a non-sed command is never allowed by this check', () => {
    expect(allowed('ls -la')).toBe(false)
  })

  test('acceptEdits mode permits in-place substitution', () => {
    expect(allowed("sed -i 's/a/b/' file.txt", true)).toBe(true)
    // ...but still not a write or execute command.
    expect(allowed("sed -i 's/a/b/w /tmp/x' file.txt", true)).toBe(false)
  })
})

describe('safe wrappers are seen through', () => {
  for (const command of [
    "timeout 5 sed -n '1,10p' file.txt",
    "env sed -n '1,10p' file.txt",
    "stdbuf -o 0 sed -n '1,10p' file.txt",
    "nice sed -n '1,10p' file.txt",
  ]) {
    test(command, () => {
      expect(allowed(command)).toBe(true)
    })
  }

  test('a wrapped dangerous sed is still refused', () => {
    expect(allowed("timeout 5 sed -n '1w /tmp/x' file.txt")).toBe(false)
  })
})

describe('expression and file-argument extraction', () => {
  test('the first non-flag argument is the expression', () => {
    expect(extractSedExpressions(['-n', '1,10p', 'file.txt'])).toEqual([
      '1,10p',
    ])
  })

  test('-e collects every expression', () => {
    expect(extractSedExpressions(['-e', 'p', '-e', '1d', 'f'])).toEqual([
      'p',
      '1d',
    ])
  })

  test('--expression= form is collected', () => {
    expect(extractSedExpressions(['--expression=p'])).toEqual(['p'])
  })

  test('a dangerous combined flag throws', () => {
    expect(() => extractSedExpressions(['-ew', 'x'])).toThrow()
    expect(() => extractSedExpressions(['-we', 'x'])).toThrow()
  })

  test('without -e, one positional is the expression and not a file', () => {
    expect(hasFileArgs(['-n', '1,10p'])).toBe(false)
    expect(hasFileArgs(['-n', '1,10p', 'f.txt'])).toBe(true)
  })

  test('with -e, every positional is a file', () => {
    expect(hasFileArgs(['-e', 'p'])).toBe(false)
    expect(hasFileArgs(['-e', 'p', 'f.txt'])).toBe(true)
  })

  test('a glob is a file argument like any other word', () => {
    // The parser resolves globs to literal strings, so there is no separate
    // glob-object case to handle.
    expect(hasFileArgs(['-n', 'p', '*.log'])).toBe(true)
  })
})

describe('checkSedConstraints scans every command', () => {
  const ctx: ToolPermissionContext = getEmptyToolPermissionContext()

  test('no sed command passes through', () => {
    expect(checkSedConstraints(commands('ls -la && pwd'), ctx).behavior).toBe(
      'passthrough',
    )
  })

  test('a safe sed in a compound command passes through', () => {
    expect(
      checkSedConstraints(commands("ls && sed -n '1p' f.txt"), ctx).behavior,
    ).toBe('passthrough')
  })

  test('a dangerous sed anywhere in the command asks', () => {
    expect(
      checkSedConstraints(commands("ls && sed -n '1w /tmp/x' f.txt"), ctx)
        .behavior,
    ).toBe('ask')
  })

  test('a dangerous sed inside a pipeline asks', () => {
    expect(
      checkSedConstraints(commands("cat f | sed 's/a/b/w /tmp/x'"), ctx)
        .behavior,
    ).toBe('ask')
  })
})
