/**
 * Test Helpers
 *
 * CLI runner, environment isolation, and assertion utilities
 * for integration tests.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..', '..')
const CLI_BINARY = join(PROJECT_ROOT, 'cli')

export interface CLIRunOptions {
  prompt: string
  serverUrl: string
  outputFormat?: 'text' | 'json' | 'stream-json'
  maxTurns?: number
  verbose?: boolean
  additionalArgs?: string[]
  additionalEnv?: Record<string, string>
  timeout?: number // ms, default 60_000
  cwd?: string // working directory, default to a temp dir
}

export interface CLIRunResult {
  stdout: string
  stderr: string
  exitCode: number
  /**
   * Parsed output:
   * - text format: the raw stdout string
   * - json format: parsed JSON object (or array if --verbose)
   * - stream-json format: array of parsed NDJSON objects
   */
  parsed: unknown
}

/**
 * Create a temporary directory for test isolation.
 * Returns the path and a cleanup function.
 */
export async function createTempDir(): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const path = await mkdtemp(join(tmpdir(), 'claude-test-'))
  return {
    path,
    cleanup: async () => {
      try {
        await rm(path, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    },
  }
}

/**
 * Verify the CLI binary exists before running tests.
 */
export function ensureBinaryExists(): void {
  const file = Bun.file(CLI_BINARY)
  if (!file.size) {
    throw new Error(
      `CLI binary not found at ${CLI_BINARY}. Run 'bun run build' first.`,
    )
  }
}

/**
 * Run the CLI in headless mode with the mock server and return results.
 *
 * This is a true E2E test: it spawns the actual compiled CLI binary,
 * points it at the mock API server via ANTHROPIC_BASE_URL, and captures
 * all output.
 */
export async function runCLI(options: CLIRunOptions): Promise<CLIRunResult> {
  const {
    prompt,
    serverUrl,
    outputFormat = 'text',
    maxTurns,
    verbose = false,
    additionalArgs = [],
    additionalEnv = {},
    timeout = 60_000,
  } = options

  // Create isolated temp dirs for config and home
  const tempConfig = await createTempDir()
  const tempHome = await createTempDir()
  const tempCwd = options.cwd ? null : await createTempDir()
  const cwd = options.cwd ?? tempCwd!.path

  try {
    // Build CLI args
    const args: string[] = [
      '--print',
      '--bare',
      '--dangerously-skip-permissions',
      '--output-format',
      outputFormat,
    ]

    if (verbose || outputFormat === 'stream-json') {
      args.push('--verbose')
    }

    if (maxTurns !== undefined) {
      args.push('--max-turns', String(maxTurns))
    }

    args.push(...additionalArgs)

    // The prompt goes as the last positional argument
    args.push(prompt)

    // Environment variables for full isolation
    const env: Record<string, string> = {
      // Minimal PATH for tool execution
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      // API config - point to mock server
      ANTHROPIC_API_KEY: 'test-key-integration-12345',
      ANTHROPIC_BASE_URL: serverUrl,
      // Isolation - prevent loading real user config
      CLAUDE_CONFIG_DIR: tempConfig.path,
      HOME: tempHome.path,
      // Disable features that would interfere with testing
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      // Test mode
      NODE_ENV: 'test',
      NO_COLOR: '1',
      // Disable telemetry/analytics
      DO_NOT_TRACK: '1',
      // Override any user-specific env
      ...additionalEnv,
    }

    const proc = Bun.spawn([CLI_BINARY, ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    })

    // Close stdin immediately since we pass prompt as arg
    proc.stdin.end()

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill()
        reject(
          new Error(
            `CLI process timed out after ${timeout}ms. stderr: (check result)`,
          ),
        )
      }, timeout)
    })

    // Wait for process to complete (with timeout)
    const [exitCode, stdoutBuf, stderrBuf] = await Promise.race([
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise,
    ])

    const stdout = stdoutBuf as string
    const stderr = stderrBuf as string

    // Parse output based on format
    let parsed: unknown

    switch (outputFormat) {
      case 'text':
        parsed = stdout
        break

      case 'json':
        try {
          parsed = JSON.parse(stdout)
        } catch {
          parsed = null
        }
        break

      case 'stream-json': {
        const lines = stdout
          .split('\n')
          .filter((line) => line.trim().length > 0)
        parsed = lines.map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { _raw: line, _parseError: true }
          }
        })
        break
      }
    }

    return {
      stdout,
      stderr,
      exitCode: exitCode as number,
      parsed,
    }
  } finally {
    // Cleanup temp dirs
    await tempConfig.cleanup()
    await tempHome.cleanup()
    if (tempCwd) await tempCwd.cleanup()
  }
}

/**
 * Extract messages of a specific type from stream-json parsed output.
 */
export function filterMessages(
  parsed: unknown,
  type: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (msg: Record<string, unknown>) => msg && msg.type === type,
  )
}

/**
 * Extract the result message from stream-json parsed output.
 */
export function getResultMessage(
  parsed: unknown,
): Record<string, unknown> | null {
  const results = filterMessages(parsed, 'result')
  return results.length > 0 ? results[results.length - 1] : null
}

/**
 * Extract assistant messages from stream-json parsed output.
 */
export function getAssistantMessages(
  parsed: unknown,
): Array<Record<string, unknown>> {
  return filterMessages(parsed, 'assistant')
}
