/**
 * Parallel e2e runner — the "last resort" speed lever, used after the
 * per-file optimizations (log-based waits, event-driven polling) rather than
 * instead of them.
 *
 * Runs each tests/e2e/*.test.ts file in its own `bun test` process, N files
 * at a time. Files are independent by construction — each owns a mock
 * server on an OS-assigned port, its own tmux sessions (unique names), and
 * `env -i` temp config/home/cwd dirs — so sharding is safe. The one shared
 * resource is CPU: the timing-sensitive repaint/blink tests (spinner,
 * task-create-collapsed-blink, sseEventDelayMs drips) can flake under
 * oversubscription, which is why the automatic worker count is derived from
 * cores but capped.
 *
 * Usage:
 *   bun run scripts/e2e-parallel.ts              # auto workers (see below)
 *   bun run scripts/e2e-parallel.ts --jobs=4     # explicit override
 */

import { readdir, stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const E2E_DIR = join(PROJECT_ROOT, 'tests', 'e2e')
const CLI_DEV = join(PROJECT_ROOT, 'cli-dev')

const jobsFlag = process.argv.find(arg => arg.startsWith('--jobs='))
const workerCount = jobsFlag
  ? Number(jobsFlag.slice('--jobs='.length))
  : // Cores/4, capped: each worker's tests spawn their own compiled CLI +
    // tmux + mock server, and a handful of tests are wall-clock sensitive
    // (spinner frame counting, streaming drip cadences) — full-core fan-out
    // starves them and turns into moving-target flakes. Measured on an
    // 18-core machine: 8 workers flakes ~2 files per run, 4 is stable and
    // still ~2x faster than serial. Use --jobs= to trade flake risk for
    // speed deliberately.
    Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4) || 2))

interface FileResult {
  file: string
  exitCode: number
}

async function main(): Promise<number> {
  // Warn on the classic e2e trap: driving a stale compiled binary. This is
  // an mtime heuristic, so it false-positives when tooling (e.g. a formatter
  // plus a git checkout) touches src/ without changing content — warn, do
  // not block; the authoritative note lives in AGENTS.md.
  const [cliMtime, srcMtime] = await Promise.all([
    stat(CLI_DEV)
      .then(s => s.mtimeMs)
      .catch(() => 0),
    newestMtime(join(PROJECT_ROOT, 'src')),
  ])
  if (cliMtime < srcMtime) {
    console.warn(
      'WARNING: cli-dev is older than the newest src/ mtime — if you changed src, run `bun run build:dev:full` first or you are testing stale code.',
    )
  }

  const files = (await readdir(E2E_DIR))
    .filter(f => f.endsWith('.test.ts'))
    .sort()
    .map(f => join(E2E_DIR, f))

  console.log(
    `Running ${files.length} e2e files across ${workerCount} workers…\n`,
  )

  const queue = [...files]
  const results: FileResult[] = []
  const workers = Array.from(
    { length: Math.min(workerCount, files.length) },
    () => runWorker(queue, results),
  )
  await Promise.all(workers)

  const failed = results.filter(r => r.exitCode !== 0)
  for (const r of failed) {
    console.error(`\n✗ ${r.file} exited with ${r.exitCode}`)
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} files passed.`,
  )
  return failed.length > 0 ? 1 : 0
}

async function runWorker(
  queue: string[],
  results: FileResult[],
): Promise<void> {
  for (;;) {
    const file = queue.shift()
    if (!file) return
    const short = file.replace(/.*\//, '')
    const proc = Bun.spawn(['bun', 'test', file], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: PROJECT_ROOT,
    })
    // Prefix every output line with the file so interleaved streams stay
    // attributable. Read both concurrently to avoid pipe deadlocks.
    await Promise.all([
      pipePrefixed(proc.stdout, short),
      pipePrefixed(proc.stderr, short),
    ])
    const exitCode = await proc.exited
    results.push({ file: short, exitCode })
    console.log(`[${short}] exit ${exitCode}`)
  }
}

async function pipePrefixed(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (line) console.log(`[${prefix}] ${line}`)
    }
  }
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(full))
    } else {
      newest = Math.max(
        newest,
        await stat(full)
          .then(s => s.mtimeMs)
          .catch(() => 0),
      )
    }
  }
  return newest
}

process.exit(await main())
