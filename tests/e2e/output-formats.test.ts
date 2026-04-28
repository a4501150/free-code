/**
 * Output Formats E2E Tests
 *
 * Tests the --print (headless) output modes by running the real compiled
 * CLI binary against the mock API server and verifying stdout structure.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test'
import { MockAnthropicServer } from '../helpers/mock-server'
import { textResponse, toolUseResponse } from '../helpers/fixture-builders'
import { createLoggingTest } from './tmux-helpers'

const test = createLoggingTest(bunTest)
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..', '..')
const CLI_BINARY = join(PROJECT_ROOT, 'cli')

// ---------------------------------------------------------------------------
// Headless runner (Bun.spawn, no tmux — CLI exits after --print)
// ---------------------------------------------------------------------------

interface HeadlessOptions {
  prompt: string
  serverUrl: string
  outputFormat: 'text' | 'json' | 'stream-json'
  maxTurns?: number
  verbose?: boolean
  additionalEnv?: Record<string, string>
  timeout?: number
}

interface HeadlessResult {
  stdout: string
  stderr: string
  exitCode: number
  parsed: unknown
}

async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const tempConfig = await mkdtemp(join(tmpdir(), 'claude-headless-config-'))
  const tempHome = await mkdtemp(join(tmpdir(), 'claude-headless-home-'))
  const tempCwd = await mkdtemp(join(tmpdir(), 'claude-headless-cwd-'))

  try {
    // Headless --print mode needs --bare to avoid interactive init flows
    // that cause early exit. --bare + --dangerously-skip-permissions for
    // headless output format testing (no interactive terminal to approve).
    const args: string[] = [
      '--print',
      '--bare',
      '--dangerously-skip-permissions',
      '--output-format',
      options.outputFormat,
    ]

    if (options.verbose || options.outputFormat === 'stream-json') {
      args.push('--verbose')
    }

    if (options.maxTurns !== undefined) {
      args.push('--max-turns', String(options.maxTurns))
    }

    args.push(options.prompt)

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      ANTHROPIC_API_KEY: 'test-key-headless-12345',
      ANTHROPIC_BASE_URL: options.serverUrl,
      CLAUDE_CONFIG_DIR: tempConfig,
      HOME: tempHome,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      NODE_ENV: 'test',
      NO_COLOR: '1',
      DO_NOT_TRACK: '1',
      ...(options.additionalEnv ?? {}),
    }

    const proc = Bun.spawn([CLI_BINARY, ...args], {
      cwd: tempCwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    })

    proc.stdin.end()

    const timeout = options.timeout ?? 60_000
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill()
        reject(new Error(`Timed out after ${timeout}ms`))
      }, timeout)
    })

    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise,
    ])

    let parsed: unknown
    switch (options.outputFormat) {
      case 'text':
        parsed = stdout
        break
      case 'json':
        try {
          parsed = JSON.parse(stdout as string)
        } catch {
          parsed = null
        }
        break
      case 'stream-json': {
        const lines = (stdout as string)
          .split('\n')
          .filter(l => l.trim().length > 0)
        parsed = lines.map(l => {
          try {
            return JSON.parse(l)
          } catch {
            return { _raw: l, _parseError: true }
          }
        })
        break
      }
    }

    return {
      stdout: stdout as string,
      stderr: stderr as string,
      exitCode: exitCode as number,
      parsed,
    }
  } finally {
    await rm(tempConfig, { recursive: true, force: true }).catch(() => {})
    await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    await rm(tempCwd, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterMessages(
  parsed: unknown,
  type: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (msg: Record<string, unknown>) => msg && msg.type === type,
  )
}

function getResultMessage(parsed: unknown): Record<string, unknown> | null {
  const results = filterMessages(parsed, 'result')
  return results.length > 0 ? results[results.length - 1] : null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Output Formats', () => {
  let server: MockAnthropicServer

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  beforeEach(() => {
    server.reset([])
  })

  test('text format returns plain text', async () => {
    server.reset([textResponse('Plain text output here')])

    const result = await runHeadless({
      prompt: 'Say something',
      serverUrl: server.url,
      outputFormat: 'text',
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Plain text output here')
    // Should NOT be JSON
    expect(result.stdout.trimStart().startsWith('{')).toBe(false)
    expect(result.stdout.trimStart().startsWith('[')).toBe(false)
  })

  test('json format returns JSON result message', async () => {
    server.reset([textResponse('JSON output content')])

    const result = await runHeadless({
      prompt: 'Say something in json',
      serverUrl: server.url,
      outputFormat: 'json',
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeDefined()

    const parsed = result.parsed as Record<string, unknown>
    expect(parsed.type).toBe('result')
    expect(parsed.subtype).toBe('success')
    expect(typeof parsed.result).toBe('string')
    expect(parsed.result).toContain('JSON output content')
  })

  test('json format with --verbose returns array of all messages', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "verbose_test"' } },
      ]),
      textResponse('Verbose output complete'),
    ])

    const result = await runHeadless({
      prompt: 'Test verbose json',
      serverUrl: server.url,
      outputFormat: 'json',
      verbose: true,
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeDefined()

    const parsed = result.parsed as Array<Record<string, unknown>>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(1)

    const types = parsed.map(m => m.type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')
  })

  test('stream-json format returns NDJSON lines', async () => {
    server.reset([textResponse('Stream json test')])

    const result = await runHeadless({
      prompt: 'Test stream json',
      serverUrl: server.url,
      outputFormat: 'stream-json',
      maxTurns: 1,
    })

    expect(result.exitCode).toBe(0)

    const parsed = result.parsed as Array<Record<string, unknown>>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)

    for (const entry of parsed) {
      expect(entry).toBeDefined()
      if (!entry._parseError) {
        expect(typeof entry.type).toBe('string')
      }
    }
  })

  test('stream-json contains assistant and result message types', async () => {
    server.reset([
      toolUseResponse([
        { name: 'Bash', input: { command: 'echo "stream_test"' } },
      ]),
      textResponse('Stream test complete'),
    ])

    const result = await runHeadless({
      prompt: 'Test stream message types',
      serverUrl: server.url,
      outputFormat: 'stream-json',
      maxTurns: 3,
    })

    expect(result.exitCode).toBe(0)

    const parsed = result.parsed as Array<Record<string, unknown>>

    const assistantMsgs = filterMessages(parsed, 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)

    const resultMsg = getResultMessage(parsed)
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.type).toBe('result')
  })
})
