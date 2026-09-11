import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { logError } from './log.js'
import { execFileNoThrow } from './execFileNoThrow.js'

// Vendored agent-browser MCP server (web_search/web_fetch/browser_*).
// Downloaded by scripts/agentBrowser.ts, copied next to the compiled binary
// by scripts/build.ts — same layout as the ripgrep/search-tools sidecars.

const sourceVendorAgentBrowserRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../vendor/agent-browser',
)

function binaryName(): string {
  return process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'
}

/**
 * Path to the vendored agent-browser executable, or undefined when this
 * platform has no sidecar (asset not published, or download skipped at build).
 *
 * execPath first: in bun-compiled binaries import.meta.url is a virtual
 * /$bunfs path, so the disk-layout lookup only works from the real executable.
 */
export function getAgentBrowserSidecarPath(): string | undefined {
  const platformDir = `${process.arch}-${process.platform}`
  const candidateRoots = [
    resolve(dirname(process.execPath), 'vendor/agent-browser'),
    sourceVendorAgentBrowserRoot,
  ]

  for (const root of candidateRoots) {
    const binPath = resolve(root, platformDir, binaryName())
    if (existsSync(binPath)) return binPath
  }

  return undefined
}

let prepared = false

/**
 * Resolve the sidecar and make it runnable. A downloaded bun-compiled
 * executable arrives `linker-signed`; once it carries com.apple.quarantine
 * Gatekeeper refuses to run it, so ad-hoc re-sign and strip the attribute
 * before spawn — the same procedure ripgrep applies to the vendored rg.
 */
export async function prepareAgentBrowserSidecar(): Promise<
  string | undefined
> {
  const binPath = getAgentBrowserSidecarPath()
  if (!binPath || process.platform !== 'darwin' || prepared) return binPath

  prepared = true
  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      binPath,
    ])
    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign vendored agent-browser: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }
    await execFileNoThrow('xattr', ['-d', 'com.apple.quarantine', binPath])
  } catch (e) {
    logError(e)
  }
  return binPath
}
