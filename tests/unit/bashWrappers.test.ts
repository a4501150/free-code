import { describe, expect, test } from 'bun:test'

import { checkSemantics, parseForSecurity } from '../../src/utils/bash/ast.js'
import { parseCommandRaw, parseCommand } from '../../src/utils/bash/parser.js'
import {
  stripWrappers,
  stripWrappersFromSource,
  stripWrappersOrUnchanged,
} from '../../src/utils/bash/wrappers.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../src/Tool.js'
import {
  bashToolCheckPermission,
  isNormalizedCdCommand,
  isNormalizedGitCommand,
} from '../../src/tools/BashTool/bashPermissions.js'
import { stripWrappersFromArgv } from '../../src/tools/BashTool/pathValidation.js'

/** Effective command name the AST security layer sees, or null if it refused. */
function semanticCommandName(command: string): string | null {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple') return null
  const cmd = parsed.commands[0]
  if (!cmd) return null
  const stripped = stripWrappers(cmd.argv)
  return stripped.kind === 'ok' ? (stripped.argv[0] ?? null) : null
}

describe('stripWrappers: recognized wrapper forms', () => {
  const wrapped: Array<[string, string[]]> = [
    ['time', ['time', 'rm', '-rf', '/tmp/x']],
    ['time --', ['time', '--', 'rm', '-rf', '/tmp/x']],
    ['nohup', ['nohup', 'rm', '-rf', '/tmp/x']],
    ['nohup --', ['nohup', '--', 'rm', '-rf', '/tmp/x']],
    ['timeout duration', ['timeout', '5', 'rm', '-rf', '/tmp/x']],
    ['timeout suffixed', ['timeout', '10s', 'rm', '-rf', '/tmp/x']],
    ['timeout fractional', ['timeout', '5.5', 'rm', '-rf', '/tmp/x']],
    ['timeout -k sep', ['timeout', '-k', '5', '10', 'rm', '-rf', '/tmp/x']],
    ['timeout -k fused', ['timeout', '-k5', '10', 'rm', '-rf', '/tmp/x']],
    ['timeout -s sep', ['timeout', '-s', 'TERM', '10', 'rm', '-rf', '/tmp/x']],
    [
      'timeout long fused',
      ['timeout', '--signal=TERM', '10', 'rm', '-rf', '/tmp/x'],
    ],
    [
      'timeout long sep',
      ['timeout', '--kill-after', '5', '10', 'rm', '-rf', '/tmp/x'],
    ],
    [
      'timeout --foreground',
      ['timeout', '--foreground', '5', 'rm', '-rf', '/tmp/x'],
    ],
    ['timeout end-of-opts', ['timeout', '--', '5', 'rm', '-rf', '/tmp/x']],
    ['nice bare', ['nice', 'rm', '-rf', '/tmp/x']],
    ['nice -n N', ['nice', '-n', '10', 'rm', '-rf', '/tmp/x']],
    ['nice -n negative', ['nice', '-n', '-5', 'rm', '-rf', '/tmp/x']],
    ['nice legacy -N', ['nice', '-10', 'rm', '-rf', '/tmp/x']],
    ['env bare', ['env', 'rm', '-rf', '/tmp/x']],
    ['env assignment', ['env', 'FOO=bar', 'rm', '-rf', '/tmp/x']],
    ['env -i', ['env', '-i', 'rm', '-rf', '/tmp/x']],
    ['env -u NAME', ['env', '-u', 'PATH', 'rm', '-rf', '/tmp/x']],
    ['stdbuf fused', ['stdbuf', '-o0', 'rm', '-rf', '/tmp/x']],
    ['stdbuf separated', ['stdbuf', '-o', '0', 'rm', '-rf', '/tmp/x']],
    ['stdbuf long', ['stdbuf', '--output=0', 'rm', '-rf', '/tmp/x']],
    ['stdbuf multiple', ['stdbuf', '-o0', '-eL', 'rm', '-rf', '/tmp/x']],
    ['nested', ['nohup', 'nice', 'timeout', '5', 'env', 'rm', '-rf', '/tmp/x']],
  ]

  for (const [name, argv] of wrapped) {
    test(`${name} resolves to rm`, () => {
      const result = stripWrappers(argv)
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      expect(result.argv).toEqual(['rm', '-rf', '/tmp/x'])
    })
  }
})

describe('stripWrappers: fails closed on unanalyzable flags', () => {
  const rejected: Array<[string, string[]]> = [
    // -S is a mini-shell that re-splits a string into argv.
    ['env -S', ['env', '-S', 'rm -rf /tmp/x']],
    // -C and -P relocate the wrapped command.
    ['env -C', ['env', '-C', '/tmp', 'rm']],
    ['env unknown flag', ['env', '--chdir=/tmp', 'rm']],
    // getopt_long also accepts a separate value, which we cannot enumerate.
    ['stdbuf long separated', ['stdbuf', '--output', '0', 'rm']],
    ['stdbuf unknown flag', ['stdbuf', '-z', 'rm']],
    ['timeout unknown short', ['timeout', '-x', '5', 'rm']],
    ['timeout unknown long', ['timeout', '--nope', '5', 'rm']],
    // GNU timeout parses durations with strtod: `.5`, `+5`, `inf` all work,
    // so an unrecognized duration must not silently leave name='timeout'.
    ['timeout strtod duration .5', ['timeout', '.5', 'eval', 'id']],
    ['timeout strtod duration inf', ['timeout', 'inf', 'eval', 'id']],
    // Flag values are allowlisted so `$(id)` cannot ride along: bash expands
    // it during word splitting BEFORE timeout runs.
    ['timeout injected flag value', ['timeout', '-k$(id)', '10', 'ls']],
    // Arithmetic expansion becomes a legacy nice adjustment at runtime.
    ['nice arithmetic expansion', ['nice', '$((0-5))', 'jq', 'system("id")']],
  ]

  for (const [name, argv] of rejected) {
    test(`${name} is unrecognized`, () => {
      expect(stripWrappers(argv).kind).toBe('unrecognized')
    })
  }
})

describe('stripWrappers: inert forms keep the wrapper as the command', () => {
  test('bare env', () => {
    expect(stripWrappersOrUnchanged(['env'])).toEqual(['env'])
  })
  test('env with only assignments', () => {
    expect(stripWrappersOrUnchanged(['env', 'FOO=bar'])).toEqual([
      'env',
      'FOO=bar',
    ])
  })
  test('timeout with no duration', () => {
    expect(stripWrappersOrUnchanged(['timeout'])).toEqual(['timeout'])
  })
  test('stdbuf with no flags', () => {
    expect(stripWrappersOrUnchanged(['stdbuf'])).toEqual(['stdbuf'])
  })
  test('non-wrapper is untouched', () => {
    expect(stripWrappersOrUnchanged(['git', 'status'])).toEqual([
      'git',
      'status',
    ])
  })
})

describe('all consumers agree on the effective command', () => {
  // Every one of these ran `rm` while at least one layer saw the wrapper name.
  // Divergence between layers is the exploitable condition: a deny rule or a
  // contextual gate silently fails to match.
  const commands = [
    'env rm -rf /tmp/x',
    'env FOO=bar rm -rf /tmp/x',
    'env -i rm -rf /tmp/x',
    'stdbuf -o 0 rm -rf /tmp/x',
    'stdbuf --output=0 rm -rf /tmp/x',
    'stdbuf -o0 rm -rf /tmp/x',
    'nice rm -rf /tmp/x',
    'nice -10 rm -rf /tmp/x',
    'nice -n 5 rm -rf /tmp/x',
    'timeout 5 rm -rf /tmp/x',
    'nohup rm -rf /tmp/x',
    'time rm -rf /tmp/x',
  ]

  for (const command of commands) {
    test(`${command} → rm everywhere`, () => {
      expect(semanticCommandName(command)).toBe('rm')

      const parsed = parseForSecurity(command)
      expect(parsed.kind).toBe('simple')
      if (parsed.kind !== 'simple') return
      // pathValidation's argv stripper must reach the same command, or wrapped
      // paths are never validated.
      expect(stripWrappersFromArgv(parsed.commands[0]!.argv)[0]).toBe('rm')
    })
  }
})

describe('regressions: wrapper forms that evaded security gates', () => {
  // `env`/`stdbuf` were stripped by checkSemantics and pathValidation but not
  // by the identity checks, so the cd+git bare-repo RCE gate never fired.
  const gitForms = [
    'git status',
    'env git status',
    'env -i git status',
    'env FOO=bar git status',
    'stdbuf -o 0 git status',
    'stdbuf --output=0 git status',
    'stdbuf -o0 git status',
    'nice git status',
    'nice -10 git status',
    'timeout 5 git status',
    'nohup git status',
    'xargs git status',
  ]

  for (const command of gitForms) {
    test(`isNormalizedGitCommand: ${command}`, () => {
      expect(isNormalizedGitCommand(command)).toBe(true)
    })
  }

  test('isNormalizedGitCommand is false for a plain non-git command', () => {
    expect(isNormalizedGitCommand('ls -la')).toBe(false)
    expect(isNormalizedGitCommand('env ls -la')).toBe(false)
  })

  const cdForms = [
    'cd /tmp',
    'env cd /tmp',
    'stdbuf -o 0 cd /tmp',
    'nice cd /tmp',
    'pushd /tmp',
    'popd',
  ]

  for (const command of cdForms) {
    test(`isNormalizedCdCommand: ${command}`, () => {
      expect(isNormalizedCdCommand(command)).toBe(true)
    })
  }

  test('isNormalizedCdCommand is false for a plain non-cd command', () => {
    expect(isNormalizedCdCommand('ls -la')).toBe(false)
  })

  test('identity checks fail safe when the command cannot be analyzed', () => {
    // Command substitution in bare argument position is refused by the walker.
    // Both predicates gate RESTRICTIONS, so "maybe" must mean true.
    const unanalyzable = 'cd $(cat /tmp/target)'
    expect(parseForSecurity(unanalyzable).kind).not.toBe('simple')
    expect(isNormalizedCdCommand(unanalyzable)).toBe(true)
    expect(isNormalizedGitCommand(unanalyzable)).toBe(true)
  })
})

describe('checkSemantics sees through wrappers to dangerous builtins', () => {
  function semanticsOk(command: string): boolean {
    const parsed = parseForSecurity(command)
    if (parsed.kind !== 'simple') return false
    return checkSemantics(parsed.commands).ok
  }

  // eval is in EVAL_LIKE_BUILTINS; every wrapper form must still reach it.
  for (const wrapper of [
    'env',
    'env -i',
    'stdbuf -o 0',
    'stdbuf --output=0',
    'nice',
    'nice -10',
    'timeout 5',
    'nohup',
    'time',
  ]) {
    test(`${wrapper} eval is rejected`, () => {
      expect(semanticsOk(`${wrapper} eval "id"`)).toBe(false)
    })
  }

  test('a plain safe command passes', () => {
    expect(semanticsOk('ls -la')).toBe(true)
    expect(semanticsOk('env ls -la')).toBe(true)
  })
})

describe('parser has no input caps', () => {
  test('parses a command far longer than the old 10,000 char limit', () => {
    // Over-length input used to return null, which routed to the legacy
    // shell-quote path — a fail-OPEN fallback.
    const long = `echo ${'a'.repeat(60_000)}`
    expect(long.length).toBeGreaterThan(10_000)

    const root = parseCommandRaw(long)
    expect(root).not.toBeNull()

    const parsed = parseForSecurity(long)
    expect(parsed.kind).toBe('simple')
    if (parsed.kind !== 'simple') return
    expect(parsed.commands[0]!.argv[0]).toBe('echo')
  })

  test('parses a deeply nested command that used to exhaust the node budget', () => {
    const deep = `echo ${'$(echo '.repeat(200)}x${')'.repeat(200)}`
    // Must not throw or hang; verdict itself is the walker's business.
    expect(() => parseCommandRaw(deep)).not.toThrow()
    expect(() => parseForSecurity(deep)).not.toThrow()
  })

  test('parsing is synchronous', () => {
    // The WASM-era async shape is gone; sync consumers like Tool.isReadOnly
    // depend on this.
    expect(parseCommandRaw('ls')).not.toBeInstanceOf(Promise)
    expect(parseCommand('ls')).not.toBeInstanceOf(Promise)
    expect(parseForSecurity('ls')).not.toBeInstanceOf(Promise)
  })
})

describe('stripWrappersFromSource: exact, and preserves source quoting', () => {
  test('strips the wrapper forms the regex stripper misses', () => {
    for (const [command, expected] of [
      ['env rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['env FOO=bar rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['env -i rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['env -u PATH rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['stdbuf -o 0 rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['stdbuf --output=0 rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['nice rm -rf /tmp/x', 'rm -rf /tmp/x'],
      ['timeout 5 rm -rf /tmp/x', 'rm -rf /tmp/x'],
      // Only the leading command is considered, matching the `^`-anchored
      // regexes this corrects.
      ['env git status && ls', 'git status && ls'],
    ] as const) {
      expect(stripWrappersFromSource(command)).toBe(expected)
    }
  })

  test('returns the original source, not a requoted argv join', () => {
    // Rules are matched by string prefix, so requoting would change matching.
    expect(stripWrappersFromSource("env rm 'a b'")).toBe("rm 'a b'")
    expect(stripWrappersFromSource('env rm "a  b"')).toBe('rm "a  b"')
  })

  test('declines rather than guessing', () => {
    for (const command of [
      // Unanalyzable wrapper flags.
      'env -S "rm -rf /tmp/x"',
      'env -C /tmp rm -rf x',
      'stdbuf --output 0 rm -rf /tmp/x',
      // No wrapper at all — no candidate to contribute.
      'rm -rf /tmp/x',
      'ls -la',
      // A quoted wrapper name is not the wrapper.
      "'env' rm -rf /tmp/x",
    ]) {
      expect(stripWrappersFromSource(command)).toBeNull()
    }
  })

  test('declines on non-ASCII, where byte offsets diverge from string indices', () => {
    // Slicing a byte offset into a JS string would corrupt the command.
    expect(stripWrappersFromSource('env rm /tmp/café')).toBeNull()
  })
})

describe('regression: deny rules see through every wrapper form', () => {
  // `env rm -rf /` and `stdbuf -o 0 rm -rf /` did not match a Bash(rm:*) deny,
  // because rule matching used the regex stripper, which handles neither.
  const denyCtx: ToolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { localSettings: ['Bash(rm:*)'] },
  }

  for (const command of [
    'rm -rf /tmp/x',
    'nice rm -rf /tmp/x',
    'nice -10 rm -rf /tmp/x',
    'timeout 5 rm -rf /tmp/x',
    'nohup rm -rf /tmp/x',
    'time rm -rf /tmp/x',
    'env rm -rf /tmp/x',
    'env -i rm -rf /tmp/x',
    'env FOO=bar rm -rf /tmp/x',
    'env -u PATH rm -rf /tmp/x',
    'stdbuf -o 0 rm -rf /tmp/x',
    'stdbuf -o0 rm -rf /tmp/x',
    'stdbuf --output=0 rm -rf /tmp/x',
  ]) {
    test(`Bash(rm:*) denies ${command}`, () => {
      expect(
        bashToolCheckPermission({ command }, denyCtx, false).behavior,
      ).toBe('deny')
    })
  }

  test('an unrelated command is not denied', () => {
    expect(
      bashToolCheckPermission({ command: 'ls -la' }, denyCtx, false).behavior,
    ).not.toBe('deny')
  })
})
