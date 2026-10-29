import { describe, expect, test } from 'bun:test'
import {
  rewritePsRedirectsToHarnessFile,
  rewriteRedirectsToHarnessFile,
  stripTrailingOutputLimiters,
} from '../../src/utils/bash/outputCapture.js'
import { BashTool } from '../../src/tools/BashTool/BashTool.js'

describe('POSIX redirect rewrite', () => {
  test('no redirection passes through', () => {
    expect(rewriteRedirectsToHarnessFile('ls -la | grep x')).toBeNull()
  })

  test('single > target is replaced, rest of the command untouched', () => {
    const r = rewriteRedirectsToHarnessFile('echo hi > /tmp/out.log')
    expect(r).not.toBeNull()
    expect(r!.rewrittenCommand).toBe(`echo hi > ${r!.harnessPath}`)
    expect(r!.originalTargets).toEqual(['/tmp/out.log'])
    expect(r!.harnessPath).toContain(r!.taskId)
  })

  test('multiple redirections across a list are all replaced', () => {
    const r = rewriteRedirectsToHarnessFile(
      'make build > /tmp/a.log 2>/dev/null && make test >> /tmp/b.log',
    )
    expect(r).not.toBeNull()
    // Every original target is gone from the rewritten command.
    expect(r!.rewrittenCommand).not.toContain('/tmp/a.log')
    expect(r!.rewrittenCommand).not.toContain('/tmp/b.log')
    expect(r!.rewrittenCommand).toContain('&& make test >>')
    expect(r!.originalTargets).toEqual([
      '/tmp/a.log',
      '/dev/null',
      '/tmp/b.log',
    ])
  })

  test('quoted or expanded targets are declined (output stays where the model aimed it)', () => {
    expect(rewriteRedirectsToHarnessFile('echo hi > "$LOG"')).toBeNull()
    expect(rewriteRedirectsToHarnessFile('echo hi > $HOME/out.log')).toBeNull()
    expect(rewriteRedirectsToHarnessFile('echo hi > "out log.txt"')).toBeNull()
  })

  test('multi-byte characters before the redirect splice at the right offset', () => {
    const r = rewriteRedirectsToHarnessFile('echo —em dash— > out.log')
    expect(r).not.toBeNull()
    expect(r!.rewrittenCommand).toBe(`echo —em dash— > ${r!.harnessPath}`)
  })

  test('pipeline producer keeps its own stdout flowing to the consumer', () => {
    const r = rewriteRedirectsToHarnessFile('build | tail -5')
    expect(r).toBeNull()
  })
})

describe('PowerShell redirect rewrite', () => {
  test('no redirection passes through', () => {
    expect(rewritePsRedirectsToHarnessFile('Get-Process')).toBeNull()
  })

  test('plain and appending file targets are replaced', () => {
    const r = rewritePsRedirectsToHarnessFile(
      'build > out.log; test >> err.log',
    )
    expect(r).not.toBeNull()
    expect(r!.rewrittenCommand).toContain(`> ${r!.harnessPath}`)
    expect(r!.rewrittenCommand).toContain(`>> ${r!.harnessPath}`)
    expect(r!.rewrittenCommand).not.toContain('out.log;')
  })

  test('2>&1 merges and quoted targets are left alone', () => {
    const merge = rewritePsRedirectsToHarnessFile('build 2>&1 | Write-Host')
    expect(merge).toBeNull()
    const quoted = rewritePsRedirectsToHarnessFile('build > "out.log"')
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

  test('redirect rewrite is reported with the original target', () => {
    const out = map({
      stdout: '',
      stderr: '',
      interrupted: false,
      outputPath: '/tmp/tasks/b3.output',
      exitCode: 0,
      redirectRewritten: {
        harnessPath: '/tmp/tasks/b3.output',
        originalTargets: ['/tmp/model.log'],
      },
    })
    expect(out).toContain(
      '[redirect rewritten: output saved to /tmp/tasks/b3.output instead of /tmp/model.log]',
    )
    expect(out).toContain('[exit 0 · full output: /tmp/tasks/b3.output]')
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
