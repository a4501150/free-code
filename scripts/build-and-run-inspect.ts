/**
 * Bundle scripts/inspect-strict-schema.ts with the same feature flags as the
 * default build, then run it. Mirrors build-and-run-dump.ts.
 *
 * Usage:
 *   bun run scripts/build-and-run-inspect.ts [model] [toolName]
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'

const [, , model, toolName] = process.argv

const defaultFeatures = [
  'BG_SESSIONS',
  'DAEMON',
  'DIRECT_CONNECT',
  'DUMP_SYSTEM_PROMPT',
  'HARD_FAIL',
  'SELF_HOSTED_RUNNER',
  'SSH_REMOTE',
  'STREAMLINED_OUTPUT',
  'TEMPLATES',
  'UNATTENDED_RETRY',
  'BUDDY',
  'HISTORY_SNIP',
  'KAIROS_DREAM',
  'REVIEW_ARTIFACT',
  'RUN_SKILL_GENERATOR',
  'WORKFLOW_SCRIPTS',
  'CACHED_MICROCOMPACT',
  'COORDINATOR_MODE',
  'KAIROS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'KAIROS_PUSH_NOTIFICATION',
  'LODESTONE',
  'NEW_INIT',
  'ULTRATHINK',
  'VOICE_MODE',
]

const bundleOut = resolve(process.cwd(), 'dist', 'inspect-strict-schema.mjs')
if (!existsSync(dirname(bundleOut))) {
  mkdirSync(dirname(bundleOut), { recursive: true })
}

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify('inspect-strict-schema'),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.PACKAGE_URL': JSON.stringify('inspect-strict-schema'),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(''),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
} as const

const buildCmd = [
  'bun',
  'build',
  './scripts/inspect-strict-schema.ts',
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

const build = Bun.spawnSync({
  cmd: buildCmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1)
}

const runArgs = ['bun', bundleOut]
if (model) runArgs.push(model)
if (toolName) runArgs.push(toolName)

const run = Bun.spawnSync({
  cmd: runArgs,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(run.exitCode ?? 0)
