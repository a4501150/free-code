import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Idle window. A tab left open overnight has to log in again. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
/** Hard ceiling regardless of activity. */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000

export const COOKIE_NAME = 'freecode_webui'
export const CSRF_HEADER = 'x-freecode-csrf'

export function getWebuiDir(): string {
  return join(getClaudeConfigHomeDir(), 'webui')
}

function getAuthPath(): string {
  return join(getWebuiDir(), 'auth.json')
}

const AuthFileSchema = z.object({
  version: z.literal(1),
  passwordHash: z.string().min(1),
  signingSecret: z.string().min(32),
  createdAt: z.string(),
})

export type AuthFile = z.infer<typeof AuthFileSchema>

export function readAuthFile(): AuthFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getAuthPath(), 'utf-8'))
    const result = AuthFileSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * Stores the password hash and the cookie signing secret.
 *
 * The password is an RCE credential: whoever holds it can approve a Bash call
 * on this machine. It is hashed with argon2 through `Bun.password` and the file
 * is owner-only.
 */
export async function writeAuthFile(password: string): Promise<AuthFile> {
  const dir = getWebuiDir()
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)

  const file: AuthFile = {
    version: 1,
    passwordHash: await Bun.password.hash(password),
    signingSecret: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  }

  const path = getAuthPath()
  // writeFileSync honors `mode` only on create, so clear any prior file first.
  rmSync(path, { force: true })
  writeFileSync(path, JSON.stringify(file), {
    encoding: 'utf-8',
    mode: FILE_MODE,
  })
  chmodSync(path, FILE_MODE)
  return file
}

export async function verifyPassword(
  auth: AuthFile,
  password: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(password, auth.passwordHash)
  } catch {
    return false
  }
}

type TokenPayload = {
  /** Issued at, epoch ms. */
  iat: number
  /** Random per-login, so a rotated cookie is a different value. */
  jti: string
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function issueSessionToken(auth: AuthFile): string {
  const payload: TokenPayload = {
    iat: Date.now(),
    jti: randomBytes(12).toString('base64url'),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(auth.signingSecret, body)}`
}

export function verifySessionToken(
  auth: AuthFile,
  token: string | undefined,
): TokenPayload | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null

  const body = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(auth.signingSecret, body))
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'))
  } catch {
    return null
  }

  const age = Date.now() - payload.iat
  if (!Number.isFinite(payload.iat) || age < 0) return null
  if (age > SESSION_ABSOLUTE_MS || age > SESSION_IDLE_MS) return null
  return payload
}

/** Derived from the session token, so it cannot be replayed across logins. */
export function csrfTokenFor(auth: AuthFile, sessionToken: string): string {
  return sign(auth.signingSecret, `csrf:${sessionToken}`)
}

export function csrfMatches(
  auth: AuthFile,
  sessionToken: string,
  provided: string | null,
): boolean {
  if (!provided) return false
  const expected = Buffer.from(csrfTokenFor(auth, sessionToken))
  const actual = Buffer.from(provided)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

export function buildSetCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_IDLE_MS / 1000)}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}

/**
 * Login throttle.
 *
 * Buckets per source address and globally, because a forwarded address from a
 * tunnel is attacker-controlled and cannot be the only key.
 */
export function createLoginThrottle(options: {
  perAddress: number
  global: number
  windowMs: number
}) {
  const byAddress = new Map<string, number[]>()
  let globalHits: number[] = []

  function prune(list: number[], now: number): number[] {
    return list.filter(at => now - at < options.windowMs)
  }

  return {
    check(address: string): boolean {
      const now = Date.now()
      globalHits = prune(globalHits, now)
      if (globalHits.length >= options.global) return false
      const list = prune(byAddress.get(address) ?? [], now)
      byAddress.set(address, list)
      return list.length < options.perAddress
    },
    record(address: string): void {
      const now = Date.now()
      globalHits.push(now)
      byAddress.set(address, [...(byAddress.get(address) ?? []), now])
    },
    reset(address: string): void {
      byAddress.delete(address)
    },
  }
}
