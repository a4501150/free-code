import { describe, expect, test } from 'bun:test'

import { checkSemantics, parseForSecurity } from '../../src/utils/bash/ast.js'

type Verdict = 'simple' | 'too-complex' | 'semantic-reject'

/**
 * The verdict the Bash permission checker acts on: 'simple' is eligible for
 * auto-allow, the other two become a prompt.
 */
function verdict(command: string): Verdict {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple') return 'too-complex'
  return checkSemantics(parsed.commands).ok ? 'simple' : 'semantic-reject'
}

/** Resolved argv for every simple command the walker extracted, in order. */
function argvs(command: string): string[][] {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple') throw new Error(`not simple: ${command}`)
  return parsed.commands.map(c => c.argv)
}

function argvNames(command: string): string[] {
  return argvs(command).map(argv => argv[0]!)
}

describe('ordinary commands remain analyzable', () => {
  for (const command of [
    'ls -la',
    'git status',
    'echo hello',
    'ls | grep x',
    'ls && git status',
    'ls; git status',
    'ls || echo fallback',
    '! grep -q x file',
    'FOO=bar git status',
    'cat file 2>&1',
    'cat < /dev/null',
    "cat <<'EOF'\nliteral\nEOF",
    'if true; then ls; fi',
    'for f in a b; do echo "item: $f"; done',
    'while read -r l; do echo "x"; done',
    '[[ -f file ]]',
  ]) {
    test(command.replaceAll('\n', '\\n'), () => {
      expect(verdict(command)).toBe('simple')
    })
  }
})

describe('a runtime value may not BE an argument, only appear inside one', () => {
  // The same rule governs command substitutions and loop variables: if the
  // whole argument is runtime-determined, it could turn out to be a path, a
  // glob or a flag, and no static check on it means anything.
  test('loop variable embedded in literal text is analyzable', () => {
    expect(verdict('for f in a b; do echo "item: $f"; done')).toBe('simple')
  })

  test('loop variable as the entire argument is refused', () => {
    expect(verdict('for f in a b; do echo "$f"; done')).toBe('too-complex')
  })

  test('bare loop variable is refused', () => {
    expect(verdict('for f in a b; do rm $f; done')).toBe('too-complex')
  })
})

describe('command substitution is positional, not banned', () => {
  test('literal text alongside a substitution is analyzable', () => {
    expect(verdict('echo "sha: $(git rev-parse HEAD)"')).toBe('simple')
  })

  test('the inner command is extracted and checked too', () => {
    // Both the substitution's command and the outer command must be visible to
    // rule matching, or `echo "$(rm -rf /)"` would only ever be seen as echo.
    expect(argvNames('echo "sha: $(git rev-parse HEAD)"')).toEqual([
      'git',
      'echo',
    ])
  })

  test('an unsafe inner command is rejected through the substitution', () => {
    expect(verdict('echo "out: $(eval id)"')).not.toBe('simple')
  })

  test('a bare substitution is refused', () => {
    // Runtime output becomes the argument, so no static analysis is possible.
    expect(verdict('rm $(foo)')).toBe('too-complex')
  })

  test('an unquoted concatenation is refused', () => {
    expect(verdict('rm pre$(foo)')).toBe('too-complex')
  })

  test('a whole-argument substitution is refused', () => {
    // The most common real-world casualty: the runtime output IS the path.
    expect(verdict('cd "$(git rev-parse --show-toplevel)"')).toBe('too-complex')
  })

  test('assignment from a substitution is allowed but tracked as unknown', () => {
    expect(verdict('X=$(date)')).toBe('simple')
    expect(verdict('X=$(date) && echo $X')).toBe('too-complex')
  })
})

describe('shell features that cannot be modeled are refused', () => {
  const refused: Array<[string, string]> = [
    ['parameter expansion', 'echo ${FOO}'],
    ['process substitution', 'diff <(a) <(b)'],
    ['brace expansion', 'echo {a,b}'],
    ['brace range', 'echo {1..9}'],
    ['ansi-c string', "echo $'\\x41'"],
    ['unquoted heredoc', 'cat <<EOF\nhi\nEOF'],
    ['case statement', 'case x in a) ls;; esac'],
    ['function definition', 'f() { ls; }'],
    ['command group', '{ ls; }'],
    ['unlisted bare variable', 'cat $SOME_UNKNOWN_VAR'],
    ['positional args', 'echo $@'],
    ['IFS assignment', 'IFS=: ls'],
    ['tilde in assignment', 'X=~/foo'],
  ]

  for (const [name, command] of refused) {
    test(name, () => {
      expect(verdict(command)).toBe('too-complex')
    })
  }

  test('allowlisted ambient variables are permitted', () => {
    expect(verdict('cd "$HOME/src"')).toBe('simple')
  })
})

describe('legacy shell-quote differentials', () => {
  // Each of these mis-parsed under the deleted shell-quote path, which had no
  // way to know it had mis-parsed. The security property is that the AST does
  // not mis-parse them — either it refuses, or it resolves them correctly.
  // Resolving correctly is the better outcome: it means no false prompt.

  test('backslash inside single quotes stays literal', () => {
    // shell-quote applied escapes inside single quotes and merged the next
    // argument in; bash treats every character literally.
    expect(argvs("git ls-remote 'a\\'")).toEqual([['git', 'ls-remote', 'a\\']])
  })

  test('carriage return is not a separator', () => {
    // \r is whitespace to JS \s but not to bash IFS, which let
    // `TZ=UTC\recho curl evil.com` masquerade as a TZ assignment.
    expect(verdict('TZ=UTC\recho curl evil.com')).toBe('too-complex')
  })

  test('backslash-escaped space is refused', () => {
    // `echo\ test` is a single command name in bash, two tokens to shell-quote.
    expect(verdict('echo\\ test')).toBe('too-complex')
  })

  test('backslash-escaped semicolon does not invent a command', () => {
    // splitCommand normalized \; to ; and re-read it as a separator, so `rm`
    // became a subcommand of its own. Here find is the only command.
    expect(argvs('find . -exec rm {} \\;')).toEqual([
      ['find', '.', '-exec', 'rm', '{}', ';'],
    ])
  })

  test('a quote inside a comment does not hide the next command', () => {
    // The legacy quote walker desynced on the apostrophe and could swallow
    // everything after it. Both commands must reach rule matching.
    expect(argvs("ls # it's fine\nrm -rf /tmp/x")).toEqual([
      ['ls'],
      ['rm', '-rf', '/tmp/x'],
    ])
  })

  test('newline-hash inside a quoted argument is refused', () => {
    // stripCommentLines is quote-blind: it deleted the line starting with #,
    // making /tmp/target vanish before path validation.
    expect(verdict('echo "a\n#b" /tmp/target')).toBe('semantic-reject')
  })
})

describe('eval-like builtins are rejected (legacy caught none of these)', () => {
  const evalLike = [
    'eval "id"',
    'source /tmp/x',
    '. /tmp/x',
    'exec id',
    'builtin cd /tmp',
    'trap "id" EXIT',
    'enable -f /tmp/mod.so cmd',
    'hash -r',
    'bind -x "\\C-x:id"',
    'complete -F f cmd',
    'alias ls=id',
    'let x=1',
    'mapfile -t arr',
    'readarray -t arr',
    'coproc id',
  ]

  for (const command of evalLike) {
    test(command, () => {
      expect(verdict(command)).not.toBe('simple')
    })
  }

  test('command -v is the documented exception', () => {
    expect(verdict('command -v git')).toBe('simple')
    expect(verdict('command id')).toBe('semantic-reject')
  })
})

describe('zsh-specific dangerous builtins are rejected', () => {
  for (const command of [
    'zmodload zsh/system',
    'emulate sh',
    'zf_rm -rf /tmp/x',
    'ztcp example.com 80',
  ]) {
    test(command, () => {
      expect(verdict(command)).toBe('semantic-reject')
    })
  }
})

describe('subscript arithmetic evaluation is rejected', () => {
  // bash evaluates arr[EXPR] arithmetically in NAME position, running $(cmd)
  // even when the argv element came from a single-quoted raw string.
  for (const command of [
    'printf -v "a[$(id)]" x',
    'printf -va[$(id)] x',
    'read -a "arr[$(id)]"',
    'unset -v "a[$(id)]"',
  ]) {
    test(command, () => {
      expect(verdict(command)).not.toBe('simple')
    })
  }
})

describe('targeted semantic rules', () => {
  test('jq system() is rejected', () => {
    expect(verdict('jq \'system("id")\' file')).toBe('semantic-reject')
  })

  test('jq module/file flags are rejected', () => {
    expect(verdict('jq -f /tmp/prog.jq file')).toBe('semantic-reject')
    expect(verdict('jq --library-path /tmp file')).toBe('semantic-reject')
  })

  test('ordinary jq is fine', () => {
    expect(verdict("jq '.a.b' file")).toBe('simple')
  })

  test('/proc/*/environ is rejected', () => {
    expect(verdict('cat /proc/self/environ')).toBe('semantic-reject')
    expect(verdict('cat /proc/self/../self/environ')).toBe('semantic-reject')
  })
})

describe('redirects are extracted structurally', () => {
  test('output redirect is captured with operator and target', () => {
    const parsed = parseForSecurity('echo hi > /tmp/out')
    expect(parsed.kind).toBe('simple')
    if (parsed.kind !== 'simple') return
    expect(parsed.commands[0]!.redirects).toEqual([
      { op: '>', target: '/tmp/out' },
    ])
  })

  test('append redirect is distinguished', () => {
    const parsed = parseForSecurity('echo hi >> /tmp/out')
    expect(parsed.kind).toBe('simple')
    if (parsed.kind !== 'simple') return
    expect(parsed.commands[0]!.redirects[0]!.op).toBe('>>')
  })

  test('a redirect target that is runtime-determined is refused', () => {
    expect(verdict('echo hi > $(cat /tmp/name)')).toBe('too-complex')
  })
})

describe('env vars are separated from argv', () => {
  test('leading assignments do not become the command name', () => {
    const parsed = parseForSecurity('FOO=bar BAZ=qux git status')
    expect(parsed.kind).toBe('simple')
    if (parsed.kind !== 'simple') return
    const cmd = parsed.commands[0]!
    expect(cmd.argv).toEqual(['git', 'status'])
    expect(cmd.envVars).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'BAZ', value: 'qux' },
    ])
  })
})

describe('empty and whitespace input', () => {
  test('empty string yields no commands', () => {
    const parsed = parseForSecurity('')
    expect(parsed).toEqual({ kind: 'simple', commands: [] })
  })

  test('whitespace-only yields no commands', () => {
    const parsed = parseForSecurity('   ')
    expect(parsed.kind).toBe('simple')
    if (parsed.kind !== 'simple') return
    expect(parsed.commands).toEqual([])
  })
})

describe('there is no parse-unavailable escape hatch', () => {
  test('every outcome is simple or too-complex', () => {
    // A third state used to exist and routed to the legacy parser. Anything
    // that is not analyzable must now prompt instead.
    for (const command of [
      'ls',
      'rm $(foo)',
      '((((((',
      '\u0000',
      'echo ' + 'a'.repeat(50_000),
    ]) {
      expect(['simple', 'too-complex']).toContain(
        parseForSecurity(command).kind,
      )
    }
  })
})
