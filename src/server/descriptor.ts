/**
 * The v2 process descriptor: how a local consumer (the gateway, another
 * session) finds a session process's HTTP surface and proves it is the same
 * process it was told about.
 *
 * Ported from the v1 attach descriptor with the socket replaced by a TCP port.
 * Same directory, same ownership/mode checks: anyone who can write here can
 * impersonate a session process, and anyone who can read here learns the
 * surface token.
 *
 * A process socket is identified by PID plus nonce, never session ID. Attach
 * only when the registry and the descriptor agree on both: descriptor rewrites
 * are asynchronous, so an early or stale descriptor can attach to the wrong
 * session.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { WIRE_VERSION } from '../session/wire.js'

export const ATTACH_DIR_MODE = 0o700
export const ATTACH_FILE_MODE = 0o600

export function getAttachDir(): string {
  return join(getClaudeConfigHomeDir(), 'attach')
}

export function getDescriptorPath(pid: number): string {
  return join(getAttachDir(), `${pid}.json`)
}

export const AttachDescriptorSchema = z.object({
  wireVersion: z.literal(WIRE_VERSION),
  pid: z.number().int().positive(),
  /**
   * Distinguishes a live process from a dead one whose PID was recycled. A
   * stale descriptor with a reused PID passes a liveness probe but fails the
   * nonce comparison the gateway makes when it first connects.
   */
  processNonce: z.string().min(8),
  /** Required in the `x-freecode-surface` header on every request. */
  token: z.string().min(16),
  /** The loopback port the surface listens on. */
  port: z.number().int().positive().max(65535),
  /**
   * The session this process serves. For a single-session process this is
   * the whole story. For a multi-session host (sessiond) it stays the
   * primary — the first hosted session id at write time, or a `sessiond`
   * marker while none is hosted — and the full list rides `sessionIds`.
   * Consumers that route by id must use `sessionIds` when present; the
   * primary alone can be a marker.
   */
  sessionId: z.string().min(1),
  /**
   * Every session id this process serves at write time (sessiond rewrites
   * the descriptor when the hosted set changes). Advisory for discovery:
   * a `/clear` rotates an id in place without a rewrite, and the routes
   * answer the rotated id, so consumers must fall back to the live route
   * rather than trust staleness.
   */
  sessionIds: z.array(z.string().min(1)).optional(),
  cwd: z.string().min(1),
  entrypoint: z.string().optional(),
  startedAt: z.number().int().positive(),
})

export type AttachDescriptor = z.infer<typeof AttachDescriptorSchema>

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
 * Validates the descriptor directory before trusting anything inside it.
 * Mirrors the posture the v1 attach host inherited from
 * src/vendor/claude-for-chrome-mcp/mcpSocketClient.ts.
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

function verifyDescriptorFile(path: string): SecurityResult {
  let stats: Stats
  try {
    stats = statSync(path)
  } catch {
    return { ok: false, reason: `${path} does not exist` }
  }
  if (!stats.isFile()) {
    return { ok: false, reason: `${path} is not a regular file` }
  }
  const owner = checkOwner(stats, path)
  if (!owner.ok) return owner
  return checkMode(stats, ATTACH_FILE_MODE, path)
}

/** Creates the descriptor directory with owner-only access. */
export function ensureAttachDir(): string {
  const dir = getAttachDir()
  mkdirSync(dir, { recursive: true, mode: ATTACH_DIR_MODE })
  return dir
}

export function writeAttachDescriptor(descriptor: AttachDescriptor): void {
  const path = getDescriptorPath(descriptor.pid)
  // writeFileSync honors `mode` only when it creates the file, so a leftover
  // descriptor from a recycled PID would keep its old mode.
  rmSync(path, { force: true })
  writeFileSync(path, JSON.stringify(descriptor), {
    encoding: 'utf-8',
    mode: ATTACH_FILE_MODE,
  })
  chmodSync(path, ATTACH_FILE_MODE)
}

export function removeAttachDescriptor(pid: number): void {
  rmSync(getDescriptorPath(pid), { force: true })
}

export type ReadDescriptorResult =
  | { ok: true; descriptor: AttachDescriptor }
  | { ok: false; reason: string }

/**
 * Reads and validates a descriptor. Every check a consumer needs before it
 * trusts a surface lives here, so a caller cannot forget one.
 */
export function readAttachDescriptor(pid: number): ReadDescriptorResult {
  const dirCheck: SecurityResult = verifyAttachDir()
  if (!dirCheck.ok) return { ok: false, reason: dirCheck.reason }

  const path = getDescriptorPath(pid)
  const fileCheck = verifyDescriptorFile(path)
  if (!fileCheck.ok) return { ok: false, reason: fileCheck.reason }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { ok: false, reason: `${path} is not valid JSON: ${String(err)}` }
  }

  const result = AttachDescriptorSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, reason: `${path} failed schema validation` }
  }
  if (result.data.pid !== pid) {
    return {
      ok: false,
      reason: `${path} claims pid ${result.data.pid}, expected ${pid}`,
    }
  }

  return { ok: true, descriptor: result.data }
}

/** TCP works everywhere, so unlike the v1 unix socket Windows is supported. */
export function isSurfaceSupportedPlatform(): boolean {
  return true
}
