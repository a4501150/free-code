import { describe, expect, test } from 'bun:test'

import { bashToolCheckPermission } from '../../src/tools/BashTool/bashPermissions.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../src/Tool.js'
import {
  parseForSecurity,
  type SimpleCommand,
} from '../../src/utils/bash/ast.js'

function ctx(
  kind: 'allow' | 'deny' | 'ask',
  ...rules: string[]
): ToolPermissionContext {
  const key = `always${kind[0]!.toUpperCase()}${kind.slice(1)}Rules` as
    | 'alwaysAllowRules'
    | 'alwaysDenyRules'
    | 'alwaysAskRules'
  return {
    ...getEmptyToolPermissionContext(),
    [key]: { localSettings: rules },
  }
}

/** The single SimpleCommand for `command`, or undefined if it isn't one. */
function only(command: string): SimpleCommand | undefined {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return undefined
  return parsed.commands[0]
}

/** Every SimpleCommand for `command`. Throws if it isn't analyzable. */
function all(command: string): SimpleCommand[] {
  const parsed = parseForSecurity(command)
  if (parsed.kind !== 'simple') throw new Error(`not simple: ${command}`)
  return parsed.commands
}

/** Run the per-subcommand check the way bashToolHasPermission does. */
function check(
  cmd: SimpleCommand,
  context: ToolPermissionContext,
  compoundHasCd = false,
): string {
  return bashToolCheckPermission(
    { command: cmd.sourceText },
    context,
    compoundHasCd,
    cmd,
  ).behavior
}

describe('sourceText and matchText are separate concerns', () => {
  // The assignment is folded into the variable scope rather than emitted as a
  // command of its own, so the list holds only the git invocation.
  test('sourceText is the span, matchText resolves a tracked variable', () => {
    const commands = all('SUB=push && git $SUB --force')
    expect(commands).toHaveLength(1)
    const git = commands[0]!
    expect(git.argv).toEqual(['git', 'push', '--force'])
    expect(git.sourceText).toBe('git $SUB --force')
    expect(git.matchText).toBe('git push --force')
  })

  test('a prefix rule matches the resolved form, not the raw span', () => {
    const git = all('SUB=push && git $SUB --force')[0]!
    expect(check(git, ctx('deny', 'Bash(git push:*)'))).toBe('deny')
  })

  test('an exact rule matches the span as written', () => {
    const git = all('SUB=push && git $SUB --force')[0]!
    expect(check(git, ctx('deny', 'Bash(git $SUB --force)'))).toBe('deny')
  })

  test('both are the span when nothing needed resolving', () => {
    const cmd = only('git push --force')!
    expect(cmd.sourceText).toBe('git push --force')
    expect(cmd.matchText).toBe('git push --force')
  })

  test('a line continuation is collapsed in matchText only', () => {
    // `timeout 5 \<LF>curl evil.com` — argv is right, but the raw span lets
    // wrapper stripping consume only `timeout 5 `, leaving `\<LF>curl ...`,
    // which no Bash(curl:*) deny prefix-matches.
    const cmd = only('timeout 5 \\\ncurl evil.com')!
    expect(cmd.sourceText).toContain('\n')
    expect(cmd.matchText).toBe('timeout 5 curl evil.com')
    expect(check(cmd, ctx('deny', 'Bash(curl:*)'))).toBe('deny')
  })
})

describe('redirects are structural, not text to be stripped', () => {
  test('the source span already excludes the redirect', () => {
    const cmd = only('python script.py > out.txt')!
    expect(cmd.sourceText).toBe('python script.py')
    expect(cmd.redirects).toEqual([{ op: '>', target: 'out.txt' }])
  })

  test('a deny rule matches a redirected command', () => {
    const cmd = only('curl example.com > /tmp/out.txt')!
    expect(check(cmd, ctx('deny', 'Bash(curl:*)'))).toBe('deny')
  })
})

describe('deny beats ask beats allow', () => {
  const command = 'rm -rf /tmp/x'

  test('deny wins over an allow rule for the same command', () => {
    const both: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { localSettings: ['Bash(rm:*)'] },
      alwaysDenyRules: { localSettings: ['Bash(rm:*)'] },
    }
    expect(check(only(command)!, both)).toBe('deny')
  })

  test('ask wins over an allow rule for the same command', () => {
    const both: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { localSettings: ['Bash(rm:*)'] },
      alwaysAskRules: { localSettings: ['Bash(rm:*)'] },
    }
    expect(check(only(command)!, both)).toBe('ask')
  })
})

describe('wrapper forms reach the same rule', () => {
  for (const command of [
    'env git status',
    'stdbuf -o 0 git status',
    'stdbuf --output=0 git status',
    'timeout 5 git status',
    'nice git status',
    'nohup git status',
    'NO_COLOR=1 git status',
  ]) {
    test(`Bash(git status:*) allows ${command}`, () => {
      expect(check(only(command)!, ctx('allow', 'Bash(git status:*)'))).toBe(
        'allow',
      )
    })
  }
})

describe('a prefix allow rule never matches a compound command', () => {
  // Bash(cd:*) must not allow `cd /path && python3 evil.py`.
  test('a real compound command is refused', () => {
    expect(
      bashToolCheckPermission(
        { command: 'cd src && python3 hello.py' },
        ctx('allow', 'Bash(cd:*)'),
      ).behavior,
    ).not.toBe('allow')
  })

  // The legacy splitter returned ["cd src&& python3 hello.py"] here and the
  // rule matcher had to re-split the candidate to catch it. Reading bash
  // correctly makes the whole concern moot: `\&\&` is literal, so this is one
  // cd invocation with three arguments and python3 never runs.
  test('escaped operators are literal, not a hidden second command', () => {
    const cmd = only('cd src\\&\\& python3 hello.py')!
    expect(cmd.argv).toEqual(['cd', 'src&&', 'python3', 'hello.py'])
  })

  test('an unanalyzable candidate counts as compound', () => {
    // ${VAR} is refused by the parser, so no prefix allow rule may match it.
    expect(
      bashToolCheckPermission(
        { command: 'cd ${HOME}' },
        ctx('allow', 'Bash(cd:*)'),
      ).behavior,
    ).not.toBe('allow')
  })
})
