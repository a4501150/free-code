import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, resolve } from 'path'

import { ensureCurrentAgentBrowser } from './agentBrowser.js'
import { ensureCurrentSearchTools } from './searchTools.js'

const pkg = (await Bun.file(
  new URL('../package.json', import.meta.url),
).json()) as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')
const useReactCompiler = args.includes('--react-compiler')

// All formerly feature-gated subsystems are compiled in unconditionally.
// The remaining feature flags are opt-in only: BUDDY, VERIFY_PLAN,
// WORKTREE_MODE, DEDICATED_SEARCH_TOOLS — enable with --feature=NAME.
// `--feature-set=dev-full` is still accepted but adds nothing.

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

function getGitHubRepo(): string {
  const remote = runCommand(['git', 'remote', 'get-url', 'origin'])
  if (!remote) return ''
  // git@github.com:owner/repo.git or https://github.com/owner/repo.git
  const sshMatch = remote.match(/git@github\.com:(.+?)(?:\.git)?$/)
  if (sshMatch?.[1]) return sshMatch[1]
  const httpsMatch = remote.match(/github\.com\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1]) return httpsMatch[1]
  return ''
}

const featureSet = new Set<string>()
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    // Accepted for compatibility; every former feature set is now compiled in.
    i += 1
    continue
  }
  if (arg.startsWith('--feature-set=')) {
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
  ...(dev ? { 'process.env.NODE_ENV': JSON.stringify('development') } : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  ...(featureSet.has('VERIFY_PLAN')
    ? { 'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('true') }
    : {}),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(getVersionChangelog()),
  'MACRO.GITHUB_REPO': JSON.stringify(getGitHubRepo()),
} as const

// WebUI browser bundle. Must run before the React Compiler staging copy, so
// the generated asset module is picked up by whichever source tree the main
// build points at. Only the clean pre-compilation client source is bundled.
{
  const { buildWebuiAssets } = await import('./build-webui-assets.js')
  const sizes = await buildWebuiAssets({ minify: !dev })
  console.log(`WebUI assets: ${sizes.jsBytes} B js, ${sizes.cssBytes} B css`)
}

// Optional React Compiler pre-build step: transforms .tsx files with
// babel-plugin-react-compiler for automatic memoization. Enabled with
// --react-compiler flag. The compiled output goes to .compiled-src/ and
// bun build points at that instead of src/.
const entrypoint = useReactCompiler
  ? './.compiled-src/entrypoints/cli.tsx'
  : './src/entrypoints/cli.tsx'

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
      '--out-dir',
      compiledDir,
      '--extensions',
      '.tsx',
      '--config-file',
      resolve(process.cwd(), 'babel.react-compiler.json'),
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

await ensureCurrentSearchTools()
await ensureCurrentAgentBrowser()

// Copy vendored native tools next to the compiled binary
const vendorDirs = ['ripgrep', 'search-tools', 'agent-browser']
for (const vendorDir of vendorDirs) {
  const vendorSrc = resolve(process.cwd(), 'vendor', vendorDir)
  const vendorDst = resolve(dirname(outfile), 'vendor', vendorDir)
  if (existsSync(vendorSrc) && resolve(vendorSrc) !== resolve(vendorDst)) {
    cpSync(vendorSrc, vendorDst, { recursive: true })
    console.log(`Copied vendor/${vendorDir} to ${vendorDst}`)
  }
}

console.log(`Built ${outfile}`)
