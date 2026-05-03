/**
 * Bundle scripts/dump-tool-schemas.ts with the same feature flags as the
 * default `bun run build` (no `--dev --feature-set=dev-full`), then run the
 * bundled output and let it write JSON + markdown to disk.
 *
 * Usage:
 *   bun run scripts/build-and-run-dump.ts <json-out> <md-out>
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'

const [, , jsonOut, mdOut] = process.argv
if (!jsonOut || !mdOut) {
  console.error(
    'Usage: bun run scripts/build-and-run-dump.ts <json-out> <md-out>',
  )
  process.exit(2)
}

// Keep this list in sync with `defaultFeatures` in scripts/build.ts.
const defaultFeatures = [
  'DAEMON',
  'DUMP_SYSTEM_PROMPT',
  'HARD_FAIL',
  'STREAMLINED_OUTPUT',
  'UNATTENDED_RETRY',
  'BUDDY',
  'KAIROS_DREAM',
  'CACHED_MICROCOMPACT',
  'COORDINATOR_MODE',
  'KAIROS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'KAIROS_PUSH_NOTIFICATION',
  'NEW_INIT',
  'ULTRATHINK',
  'VOICE_MODE',
]

const bundleOut = resolve(process.cwd(), 'dist', 'dump-tool-schemas.mjs')
if (!existsSync(dirname(bundleOut))) {
  mkdirSync(dirname(bundleOut), { recursive: true })
}

// Matches the default invocation in scripts/build.ts (no --compile, no --minify,
// no --bytecode — we want a plain ESM bundle we can run with `bun`).
const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(defaultFeatures.includes('VERIFY_PLAN')
    ? { 'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('true') }
    : {}),
  'MACRO.VERSION': JSON.stringify('dump-tool-schemas'),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.PACKAGE_URL': JSON.stringify('dump-tool-schemas'),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(''),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
} as const

const buildCmd = [
  'bun',
  'build',
  './scripts/dump-tool-schemas.ts',
  '--target',
  'bun',
  '--format',
  'esm',
  '--outfile',
  bundleOut,
  '--packages',
  'bundle',
  '--conditions',
  'bun',
]

for (const f of defaultFeatures) {
  buildCmd.push(`--feature=${f}`)
}
for (const [k, v] of Object.entries(defines)) {
  buildCmd.push('--define', `${k}=${v}`)
}

console.log('Building bundle…')
const build = Bun.spawnSync({
  cmd: buildCmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1)
}

console.log('Running bundle…')
const run = Bun.spawnSync({
  cmd: ['bun', bundleOut, jsonOut, mdOut],
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(run.exitCode ?? 0)
