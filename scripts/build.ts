import { chmodSync, existsSync, mkdirSync, cpSync, rmSync } from 'fs'
import { dirname, resolve } from 'path'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')
const useReactCompiler = args.includes('--react-compiler')

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TRANSCRIPT_CLASSIFIER',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
] as const

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = runCommand(['git', 'rev-parse', '--short=8', 'HEAD']) ?? 'unknown'
  return `${baseVersion}-dev.${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  return (
    runCommand(['git', 'log', '--format=%h %s', '-20']) ??
    'Local development build'
  )
}

const defaultFeatures = [
  // Tier 1: CLI flag / subcommand gated
  'BG_SESSIONS',
  'BYOC_ENVIRONMENT_RUNNER',
  'DAEMON',
  'DIRECT_CONNECT',
  'DUMP_SYSTEM_PROMPT',
  'HARD_FAIL',
  'SELF_HOSTED_RUNNER',
  'SSH_REMOTE',
  'STREAMLINED_OUTPUT',
  'TEMPLATES',
  'UNATTENDED_RETRY',
  // Tier 2: Slash command / skill gated
  'BREAK_CACHE_COMMAND',
  'BUDDY',
  'BUILDING_CLAUDE_APPS',
  'FORK_SUBAGENT',
  'HISTORY_SNIP',
  'KAIROS_DREAM',
  'KAIROS_GITHUB_WEBHOOKS',
  'OVERFLOW_TEST_TOOL',
  'REVIEW_ARTIFACT',
  'RUN_SKILL_GENERATOR',
  'ULTRAPLAN',
  'WORKFLOW_SCRIPTS',
  // Tier 3: Settings / env var / file gated
  'CACHED_MICROCOMPACT',
  'COORDINATOR_MODE',
  'KAIROS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'KAIROS_PUSH_NOTIFICATION',
  'LODESTONE',
  'NEW_INIT',
  // Tier 4: Active but benign (user keyword / prompt nudge)
  'ULTRATHINK',
  'VERIFICATION_AGENT',
  // Always on
  'VOICE_MODE',
]
const featureSet = new Set(defaultFeatures)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const feature of fullExperimentalFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const feature of fullExperimentalFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
const features = [...featureSet]

const outfile = compile
  ? dev
    ? './dist/cli-dev'
    : './dist/cli'
  : dev
    ? './cli-dev'
    : './cli'
const buildTime = new Date().toISOString()
const version = dev ? getDevVersion(pkg.version) : pkg.version

const outDir = dirname(outfile)
if (outDir !== '.') {
  mkdirSync(outDir, { recursive: true })
}

const externals: string[] = []

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(dev
    ? { 'process.env.NODE_ENV': JSON.stringify('development') }
    : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    dev ? getVersionChangelog() : 'https://github.com/paoloanzn/claude-code',
  ),
} as const

// Optional React Compiler pre-build step: transforms .tsx files with
// babel-plugin-react-compiler for automatic memoization. Enabled with
// --react-compiler flag. The compiled output goes to .compiled-src/ and
// bun build points at that instead of src/.
const entrypoint = useReactCompiler ? './.compiled-src/entrypoints/cli.tsx' : './src/entrypoints/cli.tsx'

if (useReactCompiler) {
  console.log('Running React Compiler pre-transform...')

  // Clean and recreate staging directory
  const compiledDir = resolve(process.cwd(), '.compiled-src')
  if (existsSync(compiledDir)) {
    rmSync(compiledDir, { recursive: true })
  }

  // Copy src/ to .compiled-src/ so non-tsx files are preserved
  cpSync(resolve(process.cwd(), 'src'), compiledDir, { recursive: true })

  // Run babel on .tsx files only
  const babelProc = Bun.spawnSync({
    cmd: [
      'npx',
      'babel',
      compiledDir,
      '--out-dir', compiledDir,
      '--extensions', '.tsx',
      '--config-file', resolve(process.cwd(), 'babel.react-compiler.json'),
      '--keep-file-extension',
    ],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (babelProc.exitCode !== 0) {
    console.error('React Compiler pre-transform failed')
    process.exit(babelProc.exitCode ?? 1)
  }

  console.log('React Compiler pre-transform complete')
}

const cmd = [
  'bun',
  'build',
  entrypoint,
  '--compile',
  '--target',
  'bun',
  '--format',
  'esm',
  '--outfile',
  outfile,
  ...(dev ? [] : ['--minify']),
  '--bytecode',
  '--packages',
  'bundle',
  '--conditions',
  'bun',
]

for (const external of externals) {
  cmd.push('--external', external)
}

for (const feature of features) {
  cmd.push(`--feature=${feature}`)
}

for (const [key, value] of Object.entries(defines)) {
  cmd.push('--define', `${key}=${value}`)
}

const proc = Bun.spawnSync({
  cmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

// Copy vendor/ripgrep next to the compiled binary
const vendorSrc = resolve(process.cwd(), 'vendor', 'ripgrep')
const vendorDst = resolve(dirname(outfile), 'vendor', 'ripgrep')
if (existsSync(vendorSrc) && resolve(vendorSrc) !== resolve(vendorDst)) {
  cpSync(vendorSrc, vendorDst, { recursive: true })
  console.log(`Copied vendor/ripgrep to ${vendorDst}`)
}

console.log(`Built ${outfile}`)
