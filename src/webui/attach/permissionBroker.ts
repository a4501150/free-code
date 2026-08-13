import { randomBytes } from 'crypto'
import type {
  WebPermissionDecision,
  WebPermissionRequest,
} from '../protocol/attachSchemas.js'

export type WebPermissionCallbacks = {
  /** Open a request. Returns an unsubscribe that removes the pending entry. */
  open(
    request: WebPermissionRequest,
    handler: (decision: WebPermissionDecision) => void,
  ): () => void
  /** Deliver a browser decision. False means the id was not pending. */
  resolve(requestId: string, decision: WebPermissionDecision): boolean
  /** Everything still awaiting a decision, for an attaching client's snapshot. */
  pending(): WebPermissionRequest[]
  newRequestId(): string
}

export type WebPermissionBrokerHooks = {
  onOpened(request: WebPermissionRequest): void
  onClosed(requestId: string, outcome: string): void
}

/**
 * Pending browser permission requests.
 *
 * The map is closure-owned rather than module-level or in AppState, matching
 * `createChannelPermissionCallbacks`: these entries hold resolver functions,
 * which do not belong in serializable state.
 *
 * A request stays open when no browser is attached. The terminal dialog, a
 * KAIROS channel and a permission hook are all still racing for it, and a
 * disconnected browser must not deny by omission.
 */
export function createWebPermissionBroker(
  hooks: WebPermissionBrokerHooks,
): WebPermissionCallbacks {
  const pending = new Map<
    string,
    {
      request: WebPermissionRequest
      handler: (decision: WebPermissionDecision) => void
    }
  >()

  return {
    newRequestId() {
      return randomBytes(9).toString('base64url')
    },

    open(request, handler) {
      pending.set(request.requestId, { request, handler })
      hooks.onOpened(request)
      return () => {
        if (pending.delete(request.requestId)) {
          hooks.onClosed(request.requestId, 'resolved_elsewhere')
        }
      }
    },

    resolve(requestId, decision) {
      const entry = pending.get(requestId)
      if (!entry) return false
      // Delete before calling: a throwing or re-entrant handler must not leave
      // the entry behind, and a duplicate decision must fall through.
      pending.delete(requestId)
      hooks.onClosed(requestId, decision.behavior)
      entry.handler(decision)
      return true
    },

    pending() {
      return [...pending.values()].map(entry => entry.request)
    },
  }
}
