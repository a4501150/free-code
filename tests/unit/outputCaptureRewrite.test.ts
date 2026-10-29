import { describe, expect, test } from 'bun:test'
import {
  rewritePsRedirectsToHarnessFile,
  rewriteRedirectsToHarnessFile,
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
