import { chmodSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { z } from 'zod'
import { ATTACH_PROTOCOL_VERSION } from '../protocol/attachSchemas.js'
import {
  ATTACH_FILE_MODE,
  getAttachDescriptorPath,
  verifyAttachDir,
  verifyAttachFile,
  type SecurityResult,
} from './security.js'

export const AttachDescriptorSchema = z.object({
  protocolVersion: z.literal(ATTACH_PROTOCOL_VERSION),
  pid: z.number().int().positive(),
  /**
   * Distinguishes a live process from a dead one whose PID was recycled. A
   * stale descriptor with a reused PID passes a liveness probe but fails the
   * nonce comparison the gateway made when it first connected.
   */
  processNonce: z.string().min(8),
  attachToken: z.string().min(16),
  socketPath: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  entrypoint: z.string().optional(),
  startedAt: z.number().int().positive(),
})

export type AttachDescriptor = z.infer<typeof AttachDescriptorSchema>

export function writeAttachDescriptor(descriptor: AttachDescriptor): void {
  const path = getAttachDescriptorPath(descriptor.pid)
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
  rmSync(getAttachDescriptorPath(pid), { force: true })
}

export type ReadDescriptorResult =
  | { ok: true; descriptor: AttachDescriptor }
  | { ok: false; reason: string }

/**
 * Reads and validates a descriptor. Every check the gateway needs before it
 * trusts a socket lives here, so a caller cannot forget one.
 */
export function readAttachDescriptor(pid: number): ReadDescriptorResult {
  const dirCheck: SecurityResult = verifyAttachDir()
  if (!dirCheck.ok) return { ok: false, reason: dirCheck.reason }

  const path = getAttachDescriptorPath(pid)
  const fileCheck = verifyAttachFile(path, 'file')
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

  const socketCheck = verifyAttachFile(result.data.socketPath, 'socket')
  if (!socketCheck.ok) return { ok: false, reason: socketCheck.reason }

  return { ok: true, descriptor: result.data }
}
