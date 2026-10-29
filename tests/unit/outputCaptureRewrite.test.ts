import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  rewritePsRedirectsForDualWrite,
  rewriteRedirectsForDualWrite,
  stripTrailingOutputLimiters,
} from '../../src/utils/bash/outputCapture.js'
import { BashTool } from '../../src/tools/BashTool/BashTool.js'

describe('POSIX redirect dual-write', () => {
  test('no redirection passes through', () => {
    expect(rewriteRedirectsForDualWrite('ls -la | grep x')).toBeNull()
  })

  test('a single > target becomes a tee stage', () => {
    const r = rewriteRedirectsForDualWrite('echo hi > /tmp/out.log')
    expect(r).not.toBeNull()
    expect(r!.rewrittenCommand).toBe('echo hi | tee /tmp/out.log')
    expect(r!.targets).toEqual([
      { target: '/tmp/out.log', operator: '>', mode: 'tee' },
    ])
    expect(r!.harnessPath).toContain(r!.taskId)
  })

  test('>> maps to tee -a', () => {
    const r = rewriteRedirectsForDualWrite('echo hi >> /tmp/out.log')
    expect(r!.rewrittenCommand).toBe('echo hi | tee -a /tmp/out.log')
    expect(r!.targets).toEqual([
      { target: '/tmp/out.log', operator: '>>', mode: 'tee' },
    ])
  })

  test('a trailing redirect on a list binds to the list end', () => {
    // bash binds `> f` to `b`; the tee stage after `b` reproduces that.
    const r = rewriteRedirectsForDualWrite('a && b > f')
    expect(r!.rewrittenCommand).toBe('a && b | tee f')
  })

  test('a mid-list redirect tees per owning statement', () => {
    const r = rewriteRedirectsForDualWrite('a > f1 && b > f2')
    expect(r!.rewrittenCommand).toBe('a | tee f1 && b | tee f2')
    expect(r!.targets.every(t => t.mode === 'tee')).toBe(true)
  })

  test('compound and loop owners tee at statement end', () => {
    const group = rewriteRedirectsForDualWrite('{ echo a; } > f')
    expect(group!.rewrittenCommand).toBe('{ echo a; } | tee f')
    const loop = rewriteRedirectsForDualWrite(
      'for i in 1; do echo $i; done >> f',
    )
    expect(loop!.rewrittenCommand).toBe(
      'for i in 1; do echo $i; done | tee -a f',
    )
  })

  test('a heredoc owner tees right after the delimiter, before the body', () => {
    // The incident shape: `cat >> file <<'EOF'` used to append to the
    // harness capture file instead of the file, silently defeating the
    // write. Inserting after the BODY instead would break the terminator
    // line (`EOF | tee …` is not a delimiter) and tee would never run.
    const r = rewriteRedirectsForDualWrite(
      "cat >> tests/unit/x.test.ts <<'EOF'\nhello\nEOF",
    )
    expect(r!.rewrittenCommand).toBe(
      "cat <<'EOF' | tee -a tests/unit/x.test.ts\nhello\nEOF",
    )
  })

  test('a redirect after the heredoc start tees at the same point', () => {
    const r = rewriteRedirectsForDualWrite("cat <<'EOF' > f\nbody\nEOF")
    expect(r!.rewrittenCommand).toBe("cat <<'EOF' | tee f\nbody\nEOF")
  })

  test('a stacked heredoc declines — the stray second heredoc is an ERROR child', () => {
    // Tee-ing here would attach the second heredoc to the tee stage.
    const r = rewriteRedirectsForDualWrite("cat >> f <<'A' <<'B'")
    expect(r!.rewrittenCommand).toBe("cat >> f <<'A' <<'B'")
    expect(r!.targets).toEqual([
      { target: 'f', operator: '>>', mode: 'passthrough' },
    ])
  })

  test('2>&1 next to a tee target composes', () => {
    const r = rewriteRedirectsForDualWrite('cmd > f 2>&1')
    expect(r!.rewrittenCommand).toBe('cmd 2>&1 | tee f')
  })

  test('fd2 targets pass through unchanged', () => {
    const r = rewriteRedirectsForDualWrite('cmd 2> err.log')
    expect(r!.rewrittenCommand).toBe('cmd 2> err.log')
    expect(r!.targets).toEqual([
      { target: 'err.log', operator: '>', mode: 'passthrough' },
    ])
    const append = rewriteRedirectsForDualWrite('cmd 2>> err.log')
    expect(append!.rewrittenCommand).toBe('cmd 2>> err.log')
  })

  test('fd1 and fd2 redirects on one statement compose independently', () => {
    const r = rewriteRedirectsForDualWrite('cmd > out 2> err')
    expect(r!.rewrittenCommand).toBe('cmd 2> err | tee out')
    expect(r!.targets).toEqual([
      { target: 'out', operator: '>', mode: 'tee' },
      { target: 'err', operator: '>', mode: 'passthrough' },
    ])
  })

  test('two fd1 redirects on one statement decline together', () => {
    // bash applies only the last redirect; a tee chain would duplicate into
    // both files.
    const r = rewriteRedirectsForDualWrite('cmd > f1 > f2')
    expect(r!.rewrittenCommand).toBe('cmd > f1 > f2')
    expect(r!.targets.every(t => t.mode === 'passthrough')).toBe(true)
  })

  test('explicit fd1 (1>) tees like a bare >', () => {
    const r = rewriteRedirectsForDualWrite('cmd 1> f')
    expect(r!.rewrittenCommand).toBe('cmd | tee f')
  })

  test('a mid-pipeline redirect passes through — tee would feed the next stage', () => {
    const r = rewriteRedirectsForDualWrite('a > f | b')
    expect(r!.rewrittenCommand).toBe('a > f | b')
    expect(r!.targets).toEqual([
      { target: 'f', operator: '>', mode: 'passthrough' },
    ])
  })

  test('redirects nested in a substitution pass through; the outer one tees', () => {
    // Tee-ing `inner > f` would change the substitution's value.
    const r = rewriteRedirectsForDualWrite('echo x $(inner > f) > out')
    expect(r!.rewrittenCommand).toBe('echo x $(inner > f) | tee out')
    expect(r!.targets).toEqual([
      { target: 'f', operator: '>', mode: 'passthrough' },
      { target: 'out', operator: '>', mode: 'tee' },
    ])
  })

  test('a greedy multi-word redirect passes through (its span covers the extra words)', () => {
    const r = rewriteRedirectsForDualWrite('cmd >f a b c')
    expect(r!.rewrittenCommand).toBe('cmd >f a b c')
    expect(r!.targets).toEqual([
      { target: 'f', operator: '>', mode: 'passthrough' },
    ])
  })

  test('/dev/null is tee-able like any other target (capture keeps what the model discarded)', () => {
    const r = rewriteRedirectsForDualWrite('cmd > /dev/null')
    expect(r!.rewrittenCommand).toBe('cmd | tee /dev/null')
  })

  test('quoted or expanded targets are declined (output stays where the model aimed it)', () => {
    expect(rewriteRedirectsForDualWrite('echo hi > "$LOG"')).toBeNull()
    expect(rewriteRedirectsForDualWrite('echo hi > $HOME/out.log')).toBeNull()
    expect(rewriteRedirectsForDualWrite('echo hi > "out log.txt"')).toBeNull()
  })

  test('&> and >& merges are declined whole', () => {
    expect(rewriteRedirectsForDualWrite('cmd &> f')).toBeNull()
    expect(rewriteRedirectsForDualWrite('cmd 2>&1')).toBeNull()
  })

  test('fd2 /dev/null stays in the command text as written', () => {
    // The model silenced stderr explicitly — the harness no longer captures
    // it; the discard is the intent.
    const r = rewriteRedirectsForDualWrite(
      'make build > /tmp/a.log 2>/dev/null && make test >> /tmp/b.log',
    )
    expect(r!.rewrittenCommand).toBe(
      'make build 2>/dev/null | tee /tmp/a.log && make test | tee -a /tmp/b.log',
    )
    expect(r!.targets).toEqual([
      { target: '/tmp/a.log', operator: '>', mode: 'tee' },
      { target: '/dev/null', operator: '>', mode: 'passthrough' },
      { target: '/tmp/b.log', operator: '>>', mode: 'tee' },
    ])
  })

  test('multi-byte characters before the redirect splice at the right offset', () => {
    const r = rewriteRedirectsForDualWrite('echo —em dash— > out.log')
    expect(r!.rewrittenCommand).toBe('echo —em dash— | tee out.log')
  })

  test('every tee-transformed command is valid bash (bash -n corpus)', () => {
    const corpus = [
      'echo hi > /tmp/out.log',
      'echo hi >> /tmp/out.log',
      'a && b > f',
      'a > f1 && b > f2',
      '{ echo a; } > f',
      'for i in 1; do echo $i; done > f',
      "cat >> f <<'EOF'\nhello\nEOF",
      "cat <<'EOF' > f\nbody\nEOF",
      'cmd > f 2>&1',
      'cmd 1> f',
      'cmd > /dev/null',
      'echo —em dash— > out.log',
      'echo x $(inner > f) > out',
    ]
    for (const command of corpus) {
      const r = rewriteRedirectsForDualWrite(command)
      expect(r).not.toBeNull()
      const check = spawnSync('bash', ['-n'], { input: r!.rewrittenCommand })
      // Warnings (e.g. "here-document delimited by end-of-file") exit 0 —
      // assert the stderr is clean too, so a broken heredoc terminator can
      // never pass silently.
      expect(
        `${command} → ${r!.rewrittenCommand}: ${check.stderr.toString()}`,
      ).toBe(`${command} → ${r!.rewrittenCommand}: `)
      expect(check.status).toBe(0)
    }
  })
})

describe('PowerShell redirect dual-write', () => {
  test('no redirection passes through', () => {
    expect(rewritePsRedirectsForDualWrite('Get-Process')).toBeNull()
  })

  test('plain and appending file targets become Tee-Object stages', () => {
    const r = rewritePsRedirectsForDualWrite('build > out.log; test >> err.log')
    expect(r).not.toBeNull()
    expect(r!.rewrittenCommand).toBe(
      'build | Tee-Object -FilePath out.log; test | Tee-Object -Append -FilePath err.log',
    )
    expect(r!.targets).toEqual([
      { target: 'out.log', operator: '>', mode: 'tee' },
      { target: 'err.log', operator: '>>', mode: 'tee' },
    ])
  })

  test('fd-digit forms pass through unchanged', () => {
    const r = rewritePsRedirectsForDualWrite('build 2> err.log')
    expect(r!.rewrittenCommand).toBe('build 2> err.log')
    expect(r!.targets).toEqual([
      { target: 'err.log', operator: '>', mode: 'passthrough' },
    ])
  })

  test('a pipe after the redirect within the statement declines', () => {
    const r = rewritePsRedirectsForDualWrite('cmd > f | next')
    expect(r!.rewrittenCommand).toBe('cmd > f | next')
    expect(r!.targets[0]!.mode).toBe('passthrough')
  })

  test('a pipe in a later statement does not block the transform', () => {
    const r = rewritePsRedirectsForDualWrite('cmd > f; other | x')
    expect(r!.rewrittenCommand).toBe('cmd | Tee-Object -FilePath f; other | x')
  })

  test('2>&1 merges and quoted targets are left alone', () => {
    const merge = rewritePsRedirectsForDualWrite('build 2>&1 | Write-Host')
    expect(merge).toBeNull()
    const quoted = rewritePsRedirectsForDualWrite('build > "out.log"')
    expect(quoted).toBeNull()
  })
})

describe('Bash result footer', () => {
  const map = (data: Record<string, unknown>) =>
    BashTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_test')
      .content as string

  test('successful foreground result ends with the exit/footer line', () => {
    const out = map({
      stdout: 'hello',
      stderr: '',
      interrupted: false,
      outputPath: '/tmp/tasks/b1.output',
      exitCode: 0,
    })
    expect(out).toContain('[exit 0 · full output: /tmp/tasks/b1.output]')
  })

  test('non-zero exit gets the footer with no separate Exit-code line', () => {
    const out = map({
      stdout: 'boom',
      stderr: '',
      interrupted: false,
      outputPath: '/tmp/tasks/b2.output',
      exitCode: 7,
    })
    expect(out).toContain('[exit 7 · full output: /tmp/tasks/b2.output]')
    expect(out).not.toContain('Exit code 7')
  })

  test('a tee dual-write is reported with its target', () => {
    const out = map({
      stdout: '',
      stderr: '',
      interrupted: false,
      outputPath: '/tmp/tasks/b3.output',
      exitCode: 0,
      redirectRewritten: {
        harnessPath: '/tmp/tasks/b3.output',
        targets: [
          { target: '/tmp/model.log', operator: '>', mode: 'tee' as const },
        ],
      },
    })
    expect(out).toContain(
      '[redirect dual-write: /tmp/model.log written as requested; the full stream is also captured below]',
    )
    expect(out).toContain('[exit 0 · full output: /tmp/tasks/b3.output]')
  })

  test('passthrough redirects are reported as not captured', () => {
    const out = map({
      stdout: '',
      stderr: '',
      interrupted: false,
      outputPath: '/tmp/tasks/b3.output',
      exitCode: 0,
      redirectRewritten: {
        harnessPath: '/tmp/tasks/b3.output',
        targets: [
          { target: 'err.log', operator: '>', mode: 'passthrough' as const },
          { target: 'out.log', operator: '>', mode: 'tee' as const },
        ],
      },
    })
    expect(out).toContain(
      '[redirects left as written: output went to err.log, not captured]',
    )
    expect(out).toContain(
      '[redirect dual-write: out.log written as requested; the full stream is also captured below]',
    )
  })

  test('backgrounded results carry no footer (launch line names the file)', () => {
    const out = map({
      stdout: '',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      backgroundTaskId: 'b4',
    })
    expect(out).not.toContain('[exit')
    expect(out).toContain('Command running in background with ID: b4')
  })
})

describe('Trailing tail/head strip', () => {
  test('strips a trailing tail with a numeric flag', () => {
    expect(stripTrailingOutputLimiters('bun run verify 2>&1 | tail -8')).toBe(
      'bun run verify 2>&1',
    )
  })

  test('strips bare tail and -n forms', () => {
    expect(stripTrailingOutputLimiters('make test | tail')).toBe('make test')
    expect(stripTrailingOutputLimiters('make test | tail -n 20')).toBe(
      'make test',
    )
    expect(stripTrailingOutputLimiters('make test | tail -n20')).toBe(
      'make test',
    )
  })

  test('strips trailing head stages', () => {
    expect(stripTrailingOutputLimiters('rg pattern src | head -5')).toBe(
      'rg pattern src',
    )
    expect(stripTrailingOutputLimiters('rg pattern src | head')).toBe(
      'rg pattern src',
    )
  })

  test('chains strip every trailing limiter stage', () => {
    expect(stripTrailingOutputLimiters('cmd | tail -20 | head -5')).toBe('cmd')
    expect(
      stripTrailingOutputLimiters('cmd | grep x | tail -3 | tail -2'),
    ).toBe('cmd | grep x')
  })

  test('non-limiter tails are left untouched', () => {
    // follow mode, byte counts, file operands, from-line offsets
    expect(stripTrailingOutputLimiters('cmd | tail -f')).toBeNull()
    expect(stripTrailingOutputLimiters('cmd | tail -c 100')).toBeNull()
    expect(stripTrailingOutputLimiters('cmd | tail /var/log/syslog')).toBeNull()
    expect(stripTrailingOutputLimiters('cmd | tail -n +5')).toBeNull()
    expect(stripTrailingOutputLimiters('cmd | tail -q -5')).toBeNull()
    expect(stripTrailingOutputLimiters('cmd | tail -5 > /tmp/x')).toBeNull()
  })

  test('a non-limiter last stage with an earlier tail declines', () => {
    // Stripping only the grep would change what tail delivers; the whole
    // pipeline must keep running as written.
    expect(stripTrailingOutputLimiters('cmd | tail -3 | grep ERROR')).toBeNull()
  })

  test('pipes inside command substitutions decline naturally', () => {
    // The rightmost pipe is inside $(): the trailing text carries the closing
    // paren, fails the strict form, and the command runs untouched.
    expect(stripTrailingOutputLimiters('echo $(a | tail -8)')).toBeNull()
    expect(stripTrailingOutputLimiters('echo $(a | tail) | tail -3')).toBe(
      'echo $(a | tail)',
    )
  })

  test('no pipeline or single-segment commands decline', () => {
    expect(stripTrailingOutputLimiters('tail -8')).toBeNull()
    expect(stripTrailingOutputLimiters('ls -la')).toBeNull()
  })

  test('multi-byte characters before the strip keep offsets correct', () => {
    const cmd = 'echo "caf\u00e9 — done" | tail -2'
    expect(stripTrailingOutputLimiters(cmd)).toBe('echo "caf\u00e9 — done"')
  })
})
