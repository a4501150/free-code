import { mkdirSync, statSync, type Stats } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export const ATTACH_DIR_MODE = 0o700
export const ATTACH_FILE_MODE = 0o600

export function getAttachDir(): string {
  return join(getClaudeConfigHomeDir(), 'attach')
}

export function getAttachSocketPath(pid: number): string {
  return join(getAttachDir(), `${pid}.sock`)
}

export function getAttachDescriptorPath(pid: number): string {
  return join(getAttachDir(), `${pid}.json`)
}

/**
 * Creates the attach directory with owner-only access. Anyone who can write
 * here can impersonate a session process to the gateway, and anyone who can
 * read here learns an attach token, so a loose mode is a real hole rather than
 * untidiness.
 */
export function ensureAttachDir(): string {
  const dir = getAttachDir()
  mkdirSync(dir, { recursive: true, mode: ATTACH_DIR_MODE })
  return dir
}

export type SecurityFailure = { ok: false; reason: string }
export type SecurityOk = { ok: true }
export type SecurityResult = SecurityOk | SecurityFailure

function checkOwner(stats: Stats, path: string): SecurityResult {
  // process.getuid is absent on Windows, where this posture does not apply and
  // the caller refuses to run at all.
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    return { ok: false, reason: `${path} is not owned by the current user` }
  }
  return { ok: true }
}

function checkMode(
  stats: Stats,
  expected: number,
  path: string,
): SecurityResult {
  const mode = stats.mode & 0o777
  if (mode !== expected) {
    return {
      ok: false,
      reason: `${path} has mode ${mode.toString(8)}, expected ${expected.toString(8)}`,
    }
  }
  return { ok: true }
}

/**
 * Validates the attach directory before trusting anything inside it. Mirrors
 * the posture in src/vendor/claude-for-chrome-mcp/mcpSocketClient.ts.
 */
export function verifyAttachDir(): SecurityResult {
  const dir = getAttachDir()
  let stats: Stats
  try {
    stats = statSync(dir)
  } catch {
    return { ok: false, reason: `${dir} does not exist` }
  }
  if (!stats.isDirectory()) {
    return { ok: false, reason: `${dir} is not a directory` }
  }
  const owner = checkOwner(stats, dir)
  if (!owner.ok) return owner
  return checkMode(stats, ATTACH_DIR_MODE, dir)
}

export function verifyAttachFile(
  path: string,
  kind: 'socket' | 'file',
): SecurityResult {
  let stats: Stats
  try {
    stats = statSync(path)
  } catch {
    return { ok: false, reason: `${path} does not exist` }
  }
  if (kind === 'socket' && !stats.isSocket()) {
    return { ok: false, reason: `${path} is not a socket` }
  }
  if (kind === 'file' && !stats.isFile()) {
    return { ok: false, reason: `${path} is not a regular file` }
  }
  const owner = checkOwner(stats, path)
  if (!owner.ok) return owner
  return checkMode(stats, ATTACH_FILE_MODE, path)
}

/**
 * Unix sockets carry the security model this feature depends on. Windows named
 * pipes need a different ACL story, so the attach host refuses to start there
 * rather than falling back to a TCP listener.
 */
export function isAttachSupportedPlatform(): boolean {
  return process.platform !== 'win32'
}
