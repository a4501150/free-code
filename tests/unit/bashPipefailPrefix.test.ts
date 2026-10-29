/**
 * The bash provider's prefix chain must enable pipefail: a model-issued
 * pipeline (`bun run verify 2>&1 | tail`) must report the failing
 * component's exit in the result footer, not the last stage's success.
 * Without it, a failed verify behind `| tail` reports [exit 0] — a silent
 * success claim over a failed command.
 */
import { describe, expect, test } from 'bun:test'
import { createBashShellProvider } from '../../src/utils/shell/bashProvider.js'

describe('bash provider prefix chain', () => {
  test('enables pipefail so piped commands report the failing component', async () => {
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })
    const { commandString } = await provider.buildExecCommand('echo hi', {
      id: 'pf1',
    })
    // The option must come before the eval so it governs the model's command.
    expect(commandString.startsWith('set -o pipefail')).toBe(true)
    const evalIndex = commandString.indexOf('eval')
    expect(evalIndex).toBeGreaterThan(0)
    expect(commandString.indexOf('set -o pipefail')).toBeLessThan(evalIndex)
  })
})
