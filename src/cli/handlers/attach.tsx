/**
 * `claude attach [sessionIdPrefix|processKey]` — the TUI as a sessiond client.
 *
 * Reads the host process's attach descriptor (sessiond's by default;
 * `--token-from-descriptor PID` names any session process), resolves the
 * target against the descriptor's `sessionIds`, and renders the same
 * AttachedSession screen the resume-conflict join path uses. The screen is
 * a viewer, not an owner: prompts and cancellations ride the wire as
 * commands, permission decisions race the browser's through the core's
 * broker, and when the stream ends the session outlives this terminal.
 */

import React from 'react'
import { readdirSync } from 'fs'
import { join } from 'path'
import { render } from '../../ink.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  getAttachDir,
  readAttachDescriptor,
  type AttachDescriptor,
} from '../../server/descriptor.js'
import { AttachedSession } from '../../screens/AttachedSession.js'
import { cliError } from '../exit.js'
import { verifyAttachDir } from '../../server/descriptor.js'

export type AttachOptions = {
  url?: string
  tokenFromDescriptor?: string
}

function listDescriptorPids(): number[] {
  const check = verifyAttachDir()
  if (!check.ok) return []
  const pids: number[] = []
  try {
    for (const name of readdirSync(getAttachDir())) {
      if (!name.endsWith('.json')) continue
      const pid = Number(name.slice(0, -'.json'.length))
      if (Number.isInteger(pid) && pid > 0) pids.push(pid)
    }
  } catch {
    return []
  }
  return pids
}

/** The sessiond descriptor when the caller did not name a pid. */
function defaultDescriptor(): {
  descriptor: AttachDescriptor
  pid: number
} | null {
  const candidates: AttachDescriptor[] = []
  for (const pid of listDescriptorPids()) {
    const read = readAttachDescriptor(pid)
    if (read.ok) candidates.push(read.descriptor)
  }
  const serveHosts = candidates.filter(d => d.entrypoint === 'sessiond')
  const picked =
    serveHosts[0] ?? (candidates.length === 1 ? candidates[0] : undefined)
  return picked ? { descriptor: picked, pid: picked.pid } : null
}

async function fetchHostedListing(
  descriptor: AttachDescriptor,
  url: string | undefined,
): Promise<Array<{ sessionId: string; processKey: string }>> {
  try {
    const base = url ?? `http://127.0.0.1:${descriptor.port}`
    const response = await fetch(`${base}/v1/sessions`, {
      headers: { 'x-freecode-surface': descriptor.token },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return []
    const body = (await response.json()) as {
      sessions?: Array<{ sessionId: string; processKey: string }>
    }
    return body.sessions ?? []
  } catch {
    return []
  }
}

export async function attachHandler(
  target: string | undefined,
  options: AttachOptions,
): Promise<void> {
  // The descriptor is the trust anchor: it names the port, carries the
  // token, and every ownership check lives in readAttachDescriptor.
  const named = options.tokenFromDescriptor
    ? Number(options.tokenFromDescriptor)
    : 0
  if (
    options.tokenFromDescriptor !== undefined &&
    (!Number.isInteger(named) || named <= 0)
  ) {
    cliError(
      `--token-from-descriptor expects a pid, got '${options.tokenFromDescriptor}'`,
    )
    return
  }

  let host: { pid: number; descriptor: AttachDescriptor } | undefined
  const resolve = (wantPid: number): AttachDescriptor | null => {
    const read = readAttachDescriptor(wantPid)
    if (!read.ok) {
      cliError(`attach: ${read.reason}`)
      return null
    }
    return read.descriptor
  }

  if (named > 0) {
    const d = resolve(named)
    if (!d) return
    host = { pid: named, descriptor: d }
  } else {
    // A `pid:nonce` target may name the session process itself (an external
    // row's processKey), not just a session on the default host.
    const targetParts = target?.split(':')
    const targetPid = targetParts?.length === 2 ? Number(targetParts[0]) : NaN
    if (Number.isInteger(targetPid) && targetPid > 0) {
      const read = readAttachDescriptor(targetPid)
      if (read.ok && read.descriptor.processNonce === targetParts![1]) {
        host = { pid: targetPid, descriptor: read.descriptor }
      }
    }
    if (!host) {
      const fallback = defaultDescriptor()
      if (!fallback) {
        cliError(
          'attach: no running session host found. Start one with ' +
            '`claude web serve`, or pass --token-from-descriptor <pid>.',
        )
        return
      }
      host = fallback
    }
  }
  const { pid, descriptor } = host

  // Resolve the target to a session id the host actually serves. A bare id
  // or prefix matches the descriptor's list; a processKey matches the live
  // `/v1/sessions` listing (its per-session nonce is not in the descriptor).
  const candidates = descriptor.sessionIds ?? [descriptor.sessionId]
  let sessionId = descriptor.sessionId
  if (target) {
    if (target.includes(':')) {
      const sep = target.indexOf(':')
      const targetPid = Number(target.slice(0, sep))
      const targetNonce = target.slice(sep + 1)
      if (
        targetPid === descriptor.pid &&
        targetNonce === descriptor.processNonce
      ) {
        sessionId = descriptor.sessionId
      } else {
        const listing = await fetchHostedListing(descriptor, options.url)
        const match = listing.find(entry => entry.processKey === target)
        if (!match) {
          cliError(`attach: no session with process key ${target}`)
          return
        }
        sessionId = match.sessionId
      }
    } else {
      const matches = candidates.filter(id => id.startsWith(target))
      if (matches.length === 1) sessionId = matches[0]!
      else if (matches.length > 1) {
        cliError(
          `attach: '${target}' is ambiguous among ${matches
            .map(id => id.slice(0, 8))
            .join(', ')}`,
        )
        return
      } else if (candidates.length === 1 && target === candidates[0]) {
        sessionId = target
      } else {
        // One last live check: a `/clear` rotates an id out of the
        // descriptor without a rewrite.
        const listing = await fetchHostedListing(descriptor, options.url)
        const match = listing.find(entry => entry.sessionId.startsWith(target))
        if (!match) {
          cliError(
            `attach: no served session starts with '${target}' ` +
              `(serving: ${candidates.map(id => id.slice(0, 8)).join(', ') || 'none'})`,
          )
          return
        }
        sessionId = match.sessionId
      }
    }
  } else if (candidates.length !== 1) {
    cliError(
      candidates.length === 0
        ? 'attach: the host serves no sessions yet.'
        : `attach: the host serves ${candidates.length} sessions; name one by id prefix or process key.`,
    )
    return
  } else {
    sessionId = candidates[0]!
  }

  const { unmount } = await render(
    // Same provider posture the other command TUIs use; the screen owns
    // its exit affordances (Ctrl+C, disconnected-banner Select) and its own
    // keybinding provider (AttachedSession wraps itself, so joining from
    // screens that lack one — the join paths, the hosted launcher — works
    // identically).
    <AlternateScreen>
      <AppStateProvider>
        <AttachedSession
          pid={pid}
          sessionId={sessionId}
          url={options.url}
          label={sessionId.slice(0, 8)}
          onExit={() => unmount()}
        />
      </AppStateProvider>
    </AlternateScreen>,
    { exitOnCtrlC: false },
  )
}
