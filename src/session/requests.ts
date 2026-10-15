/**
 * Session request broker — every surface where the session waits on a human.
 *
 * Successor of `webui/attach/permissionBroker.ts`, generalized to the v2
 * request union (permission with its question/plan UI enrichments, hook
 * prompts, MCP elicitations) and moved to session scope: each `SessionState`
 * gets one broker via `scopedStore`, so a permission asked by session A is
 * never answerable by session B's client. The permission policy chain (the
 * `claim()` race across terminal dialog, channels, hooks and remote clients)
 * opens requests HERE — one site for every process kind, which is what the
 * pre-core world lacked (the interactive relay lived in the TUI handler, and
 * headless wrapped `canUseTool` post-hoc with a structurally different copy).
 *
 * A request stays open when no client is attached (a disconnect must not
 * deny by omission); `cancelAll` exists for turn teardown.
 *
 * Mode-change note: `allow` with `setMode` does not apply the mode here.
 * The server applies `mode_set` before dispatching the response (same order
 * the browser used: mode lands before tool execution resumes).
 */

import { randomBytes } from 'crypto'
import { scopedStore } from '../bootstrap/state.js'
import type { WireRequest, WireRequestResponse } from './wire.js'
import type { WireRequestOutcome } from './wire.js'

export type SessionRequestListener = (
  event:
    | { type: 'opened'; request: WireRequest }
    | {
        type: 'closed'
        requestId: string
        outcome: WireRequestOutcome
      },
) => void

export type SessionRequestBroker = {
  newRequestId(): string
  /** Open a request. Returns an unsubscribe that closes it as cancelled. */
  open(
    request: WireRequest,
    respond: (response: WireRequestResponse) => void,
  ): () => void
  /** Deliver a client response. False means the id was not pending. */
  respondTo(requestId: string, response: WireRequestResponse): boolean
  /** Everything still awaiting a response, for a connecting client's snapshot. */
  pending(): WireRequest[]
  subscribe(listener: SessionRequestListener): () => void
  /** Close everything (turn aborted while prompts were open). */
  cancelAll(): void
}

function createBroker(): SessionRequestBroker {
  const pending = new Map<
    string,
    { request: WireRequest; respond: (response: WireRequestResponse) => void }
  >()
  const listeners = new Set<SessionRequestListener>()

  return {
    newRequestId() {
      return randomBytes(9).toString('base64url')
    },

    open(request, respond) {
      pending.set(request.requestId, { request, respond })
      for (const l of listeners) l({ type: 'opened', request })
      return () => {
        if (pending.delete(request.requestId)) {
          for (const l of listeners)
            l({
              type: 'closed',
              requestId: request.requestId,
              outcome: 'cancelled',
            })
        }
      }
    },

    respondTo(requestId, response) {
      const entry = pending.get(requestId)
      if (!entry) return false
      // Delete before dispatching: a throwing or re-entrant responder must
      // not leave the entry behind, and a duplicate response must fall through.
      pending.delete(requestId)
      for (const l of listeners)
        l({ type: 'closed', requestId, outcome: 'resolved' })
      entry.respond(response)
      return true
    },

    pending() {
      return [...pending.values()].map(entry => entry.request)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    cancelAll() {
      for (const requestId of [...pending.keys()]) {
        if (pending.delete(requestId)) {
          for (const l of listeners)
            l({ type: 'closed', requestId, outcome: 'cancelled' })
        }
      }
    },
  }
}

const storeBroker = scopedStore<SessionRequestBroker>(createBroker)

/**
 * The request broker of the ACTIVE session scope (the root scope's broker
 * when unscoped, which is every single-session process). The permission
 * chain runs inside the core's scope, so this resolves to the right session
 * without any handle passing.
 */
export function currentSessionRequests(): SessionRequestBroker {
  return storeBroker()
}
