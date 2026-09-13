import { describe, expect, mock, test } from 'bun:test'

mock.module('../../src/bootstrap/state.js', () => ({
  getAllowedSettingSources: () => [
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
  ],
}))

const { SettingsSchema } = await import('../../src/utils/settings/types.js')
const { getDefaultStatusLineCommand } =
  await import('../../src/statusline/defaultScript.js')

describe('statusLine settings schema', () => {
  test('accepts a command statusline', () => {
    const result = SettingsSchema()
      .strict()
      .safeParse({
        statusLine: { type: 'command', command: 'echo hi', padding: 1 },
      })
    expect(result.success).toBe(true)
  })

  test('accepts the off statusline', () => {
    const result = SettingsSchema()
      .strict()
      .safeParse({ statusLine: { type: 'off' } })
    expect(result.success).toBe(true)
  })

  test('accepts an absent statusline (embedded default applies)', () => {
    expect(SettingsSchema().strict().safeParse({}).success).toBe(true)
  })

  test('rejects an unknown statusline type', () => {
    const result = SettingsSchema()
      .strict()
      .safeParse({ statusLine: { type: 'bogus' } })
    expect(result.success).toBe(false)
  })
})

describe('embedded default statusline script', () => {
  test('materializes once and stays stable', async () => {
    const command = getDefaultStatusLineCommand()
    expect(getDefaultStatusLineCommand()).toBe(command)
    expect(command.startsWith('bash ')).toBe(true)

    const path = command.slice('bash '.length).replace(/^'|'$/g, '')
    const content = await Bun.file(path).text()
    expect(content).toContain('used_percentage')
    // The rendered marks must be plain ASCII for cross-terminal support.
    expect(content).toMatch(/#\$\{C_TEXT\}|C_MODEL\}#/)
  })

  test('renders explicit zero when used_percentage is null', async () => {
    const command = getDefaultStatusLineCommand()
    const path = command.slice('bash '.length).replace(/^'|'$/g, '')
    const payload = JSON.stringify({
      model: { id: 'test:model' },
      cwd: '/tmp',
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_creation_input_tokens: 0,
        total_cache_read_input_tokens: 0,
        context_window_size: 262144,
        current_usage: null,
        used_percentage: null,
        remaining_percentage: null,
      },
    })
    const proc = Bun.spawn(['bash', path], {
      stdin: 'pipe',
      stdout: 'pipe',
    })
    proc.stdin.write(payload)
    proc.stdin.end()
    const output = await new Response(proc.stdout).text()
    expect(output).toContain('0.0k/262.1k (0%)')
  })
})
