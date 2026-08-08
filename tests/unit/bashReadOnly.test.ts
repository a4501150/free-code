import { describe, expect, test } from 'bun:test'

import { isNormalizedCdCommand } from '../../src/tools/BashTool/bashPermissions.js'
import { checkReadOnlyConstraints } from '../../src/tools/BashTool/readOnlyValidation.js'

/**
 * The read-only classifier is a positive auto-approval: extractMemories and
 * PromptSuggestion/speculation both act on `allow` without prompting. A false
 * positive here bypasses the permission dialog outright, so this suite pins the
 * whole corpus rather than a sample.
 */
function verdict(command: string): string {
  return checkReadOnlyConstraints({ command }, isNormalizedCdCommand(command))
    .behavior
}

// Verdicts captured from the pre-migration string-based classifier and
// re-verified after the port. Five entries differ from that snapshot and are
// called out in their own test below.
const READ_ONLY: string[] = [
  'ls',
  'ls -la',
  'ls /tmp',
  'pwd',
  'whoami',
  'id',
  'uname -a',
  'date',
  'cat file.txt',
  'cat a b c',
  'head -n 5 f',
  'tail -f log',
  'wc -l f',
  'stat f',
  'strings bin',
  'hexdump -C f',
  'od -c f',
  'nl f',
  'cal',
  'uptime',
  'free -m',
  'df -h',
  'du -sh .',
  'locale',
  'groups',
  'nproc',
  'basename /a/b',
  'dirname /a/b',
  'realpath .',
  'cut -d: -f1 f',
  'paste a b',
  'tr a b',
  'column -t f',
  'tac f',
  'rev f',
  'fold -w 80 f',
  'expand f',
  'unexpand f',
  'fmt f',
  'comm a b',
  'cmp a b',
  'numfmt --to=si',
  'readlink -f f',
  'diff a b',
  'true',
  'false',
  'sleep 1',
  'which git',
  'type ls',
  'expr 1 + 1',
  'test -f f',
  'getconf PAGESIZE',
  'seq 1 10',
  'tsort f',
  'pr f',
  'echo hello',
  'echo "hello world"',
  "echo 'a b'",
  'echo hi 2>&1',
  'history',
  'history 20',
  'arch',
  'arch --help',
  'ip addr',
  'ifconfig',
  'ifconfig eth0',
  'node -v',
  'node --version',
  'python --version',
  'python3 --version',
  'claude -h',
  'claude --help',
  'uniq',
  'uniq -c',
  'pwd && ls',
  'ls | grep x',
  'ls | wc -l',
  'cd /tmp',
  'cd',
  'find .',
  'find . -name x',
  'tree',
  'tree -L 2',
  'jq .a file.json',
  "jq '.a.b' f",
  'grep pattern f',
  'grep -r x .',
  'rg pattern',
  'sort f',
  'sed -n "1,5p" f',
  'git status',
  'git log',
  'git log --oneline',
  'git diff',
  'git diff --stat',
  'git blame f',
  'git ls-files',
  'git show HEAD',
  'git branch',
  'git tag',
  'git remote -v',
  'git config --get user.name',
  'git reflog',
  'git rev-parse HEAD',
  'git describe',
  'ls > /dev/null',
  'ls 2> /dev/null',
  'ls 2>&1',
  'cd /tmp && ls',
  'ls; pwd',
  'ls || echo fail',
  'ls & pwd',
  '! grep -q x f',
  "ls '*'",
  'ls | xargs echo',
  'ls | xargs grep x',
  'find . | xargs wc -l',
  'cat \\\\server\\share\\f',
  "cat <<'EOF'\nhi\nEOF",
  'if true; then ls; fi',
  'grep --file=/tmp/p f',
  'grep -f /tmp/p f',
  'tail --follow=name f',
  'head -c 100 f',
  'ls --color=auto',
  'ls -- -weird',
  'du --exclude=x .',
]

const NOT_READ_ONLY: Array<[string, string]> = [
  ['alias', 'passthrough'],
  ['git commit -m x', 'passthrough'],
  ['git push', 'passthrough'],
  ['git add .', 'passthrough'],
  ['git checkout main', 'passthrough'],
  ['git tag -d v1', 'passthrough'],
  ['git branch -D x', 'passthrough'],
  ['git reflog expire --all', 'passthrough'],
  ['git -c core.fsmonitor=evil status', 'passthrough'],
  ['git --exec-path=/tmp status', 'passthrough'],
  ['git --config-env=x=Y status', 'passthrough'],
  ['git diff --output=/tmp/pwned', 'passthrough'],
  ['rm -rf /tmp/x', 'passthrough'],
  ['mv a b', 'passthrough'],
  ['cp a b', 'passthrough'],
  ['mkdir d', 'passthrough'],
  ['touch f', 'passthrough'],
  ['chmod 755 f', 'passthrough'],
  ['npm install', 'passthrough'],
  ['curl example.com', 'passthrough'],
  ['wget x', 'passthrough'],
  ['python script.py', 'passthrough'],
  ['node script.js', 'passthrough'],
  ['make', 'passthrough'],
  ['cargo build', 'passthrough'],
  ['kill 123', 'passthrough'],
  ['ls > /tmp/out', 'passthrough'],
  ['ls >> /tmp/out', 'passthrough'],
  ['cat f > /tmp/x', 'passthrough'],
  ['echo hi > /tmp/x', 'passthrough'],
  ['ls < /dev/null', 'passthrough'],
  ['cat < f', 'passthrough'],
  ['ls > /dev/nullo', 'passthrough'],
  ['echo hi >| /tmp/x', 'passthrough'],
  ['ls &> /tmp/x', 'passthrough'],
  ['cd /tmp && git status', 'passthrough'],
  ['ls && rm -rf /tmp/x', 'passthrough'],
  ['cd src && python3 hello.py', 'passthrough'],
  ['mkdir -p hooks && echo x > hooks/pre-commit && git status', 'passthrough'],
  ['touch HEAD && git status', 'passthrough'],
  ['mkdir objects && git log', 'passthrough'],
  ['ls *', 'passthrough'],
  ['ls *.txt', 'passthrough'],
  ['python *', 'passthrough'],
  ['cat $FILE', 'passthrough'],
  ['cat "$HOME/f"', 'passthrough'],
  ['uniq --skip-chars=0$_', 'passthrough'],
  ['echo $PATH', 'passthrough'],
  ['find ./ -?xec', 'passthrough'],
  ['ls ${HOME}', 'passthrough'],
  ['ls $(pwd)', 'passthrough'],
  ['ls `pwd`', 'passthrough'],
  ['timeout 5 ls', 'passthrough'],
  ['nice ls', 'passthrough'],
  ['nohup ls', 'passthrough'],
  ['time ls', 'passthrough'],
  ['env ls -la', 'passthrough'],
  ['stdbuf -o 0 ls', 'passthrough'],
  ['stdbuf -o0 ls', 'passthrough'],
  ['env git status', 'passthrough'],
  ['timeout 5 rm -rf /tmp/x', 'passthrough'],
  ['NO_COLOR=1 ls', 'passthrough'],
  ['FOO=bar ls', 'passthrough'],
  ['LD_PRELOAD=/tmp/x ls', 'passthrough'],
  ['ls | xargs rm', 'passthrough'],
  ['xargs git status', 'passthrough'],
  ['ls | xargs -n1 grep x', 'passthrough'],
  ['eval "ls"', 'passthrough'],
  ['source /tmp/x', 'passthrough'],
  ['. /tmp/x', 'passthrough'],
  ['exec ls', 'passthrough'],
  ['trap "ls" EXIT', 'passthrough'],
  ['alias ls=rm', 'passthrough'],
  ['let x=1', 'passthrough'],
  ['mapfile -t a', 'passthrough'],
  ['hash -r', 'passthrough'],
  ['ls \\\\10.0.0.1\\c$', 'passthrough'],
  ['ls (', 'passthrough'],
  ['((((', 'passthrough'],
  ['cat <<EOF\nhi\nEOF', 'passthrough'],
  ['diff <(a) <(b)', 'passthrough'],
  ['echo {a,b}', 'passthrough'],
  ['echo {1..9}', 'passthrough'],
  ["echo $'\\x41'", 'passthrough'],
  ['case x in a) ls;; esac', 'passthrough'],
  ['f() { ls; }', 'passthrough'],
  ['{ ls; }', 'passthrough'],
  ['for f in a b; do echo "x: $f"; done', 'passthrough'],
  ['while read -r l; do echo x; done', 'passthrough'],
  ['[[ -f f ]]', 'passthrough'],
  ['sort -o /tmp/out f', 'passthrough'],
  ['tree -o /tmp/out', 'passthrough'],
  ['awk "{print}" f', 'passthrough'],
  ['awk -f /tmp/prog f', 'passthrough'],
  ['find . -delete', 'passthrough'],
  ['find . -exec rm {} ;', 'passthrough'],
  ['find . -fprint /tmp/x', 'passthrough'],
  ['jq -f /tmp/prog.jq f', 'passthrough'],
  ['jq --library-path /tmp f', 'passthrough'],
  ['jq "env" f', 'passthrough'],
]

describe('commands classified read-only', () => {
  for (const command of READ_ONLY) {
    test(command.replaceAll('\n', '\\n'), () => {
      expect(verdict(command)).toBe('allow')
    })
  }
})

describe('commands not classified read-only', () => {
  for (const [command, expected] of NOT_READ_ONLY) {
    test(command.replaceAll('\n', '\\n'), () => {
      expect(verdict(command)).toBe(expected)
    })
  }
})

describe('differences from the string-based classifier', () => {
  // `alias` can define `alias ls=rm`, so checkSemantics refuses it by name
  // before the read-only allowlist is consulted. Bare `alias` merely lists
  // aliases, so this costs one prompt.
  test('bare alias now prompts', () => {
    expect(verdict('alias')).toBe('passthrough')
  })

  // These four are lists of read-only commands that the legacy parser could
  // not analyze at all, so it fell back to "not read-only".
  for (const command of [
    'ls & pwd',
    '! grep -q x f',
    "cat <<'EOF'\nhi\nEOF",
    'if true; then ls; fi',
  ]) {
    test(`now correctly read-only: ${command.replaceAll('\n', '\\n')}`, () => {
      expect(verdict(command)).toBe('allow')
    })
  }
})

describe('redirects are read structurally', () => {
  test('fd duplication stays read-only', () => {
    expect(verdict('ls 2>&1')).toBe('allow')
  })

  test('a write to /dev/null stays read-only', () => {
    expect(verdict('ls > /dev/null')).toBe('allow')
    expect(verdict('ls 2> /dev/null')).toBe('allow')
  })

  test('a prefix of /dev/null is not /dev/null', () => {
    // `> /dev/nullo` once matched /dev/null as a string prefix.
    expect(verdict('ls > /dev/nullo')).not.toBe('allow')
  })

  test('any write to a real file is not read-only', () => {
    for (const command of [
      'ls > /tmp/x',
      'ls >> /tmp/x',
      'ls >| /tmp/x',
      'ls &> /tmp/x',
      'wc -l f > out',
      'echo hi > hooks/pre-commit',
    ]) {
      expect(verdict(command)).not.toBe('allow')
    }
  })

  test('an input redirect is not read-only', () => {
    // Reading is harmless, but nothing in this flow validates the path.
    expect(verdict('cat < f')).not.toBe('allow')
    expect(verdict('ls < /dev/null')).not.toBe('allow')
  })
})

describe('the git contextual gates still fire', () => {
  test('cd plus git is refused', () => {
    expect(verdict('cd /tmp && git status')).not.toBe('allow')
  })

  test('creating a git-internal path then running git is refused', () => {
    for (const command of [
      'mkdir -p hooks && echo x > hooks/pre-commit && git status',
      'touch HEAD && git status',
      'mkdir objects && git log',
      'echo x > refs/heads/main && git branch',
    ]) {
      expect(verdict(command)).not.toBe('allow')
    }
  })

  test('git config injection flags are refused', () => {
    for (const command of [
      'git -c core.fsmonitor=evil status',
      'git --exec-path=/tmp status',
      'git --config-env=x=Y status',
      'git diff --output=/tmp/pwned',
    ]) {
      expect(verdict(command)).not.toBe('allow')
    }
  })

  test('a wrapped git command is still seen as git', () => {
    // isNormalizedGitCommand normalizes wrappers, so the cd+git gate fires.
    expect(verdict('cd /tmp && env git status')).not.toBe('allow')
    expect(verdict('cd /tmp && stdbuf -o 0 git status')).not.toBe('allow')
  })
})

describe('environment assignments defeat read-only classification', () => {
  for (const command of [
    'LD_PRELOAD=/tmp/x ls',
    'GIT_DIR=/tmp/evil git status',
    'PATH=/tmp ls',
    'NO_COLOR=1 ls',
  ]) {
    test(command, () => {
      expect(verdict(command)).not.toBe('allow')
    })
  }
})

describe('quoting is preserved where it matters', () => {
  test('an unquoted glob is not read-only', () => {
    // `python *` could expand to `python --help` if such a file exists.
    expect(verdict('python *')).not.toBe('allow')
    expect(verdict('find ./ -?xec')).not.toBe('allow')
  })

  test('a quoted glob is literal and stays read-only', () => {
    // argv alone cannot tell these apart, which is why the check reads the
    // source span.
    expect(verdict("ls '*'")).toBe('allow')
  })

  test('a variable expansion is not read-only', () => {
    for (const command of [
      'cat $FILE',
      'ls $HOME',
      'cd "$HOME"',
      'uniq --skip-chars=0$_',
    ]) {
      expect(verdict(command)).not.toBe('allow')
    }
  })
})

describe('eval-like and wrapped-dangerous commands', () => {
  for (const command of [
    'eval ls',
    'source /tmp/x',
    '. /tmp/x',
    'exec ls',
    'trap "rm -rf /" EXIT',
    'alias ls=rm',
    'let x=1',
    'hash -r',
    'zmodload zsh/system',
    'timeout 5 rm -rf /tmp/x',
    'env rm -rf /tmp/x',
    'stdbuf -o 0 rm -rf /tmp/x',
    'timeout -k$(id) 10 ls',
    'echo `rm -rf /`',
    'echo $(rm -rf /)',
  ]) {
    test(command, () => {
      expect(verdict(command)).not.toBe('allow')
    })
  }
})
