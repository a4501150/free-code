import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectGatewayInfo,
  connectSessionStream,
  fetchImage as fetchImageBytes,
  sendCommand,
  type CommandResult,
  type SessionCommandRoute,
  type SessionStream,
} from '../api.js'
import type {
  WireCommand,
  WireEvent,
  WireImagePayload,
} from '../../../session/wire.js'

export type Gateway = {
  connected: boolean
  /** Points the event stream, command sender and image reader at one process. */
  attachSession(processKey: string): void
  /**
   * Stop watching the current process. React state alone cannot do this: the
   * stream stays open and keeps feeding a view the user has left.
   */
  detachSession(): void
  /** POSTs to the attached session; resolves a failure rather than rejecting. */
  command(route: SessionCommandRoute, body: WireCommand): Promise<CommandResult>
  /** Bytes for one transcript image of the attached session. */
  fetchImage(itemId: string): Promise<WireImagePayload>
}

/**
 * Owns the gateway info socket and the one attached session stream.
 *
 * Deliberately narrow: it does not poll, and it performs no session-list HTTP.
 * The caller decides what an event or an offline stream means.
 */
export function useGateway({
  csrf,
  onEvent,
  onStreamOffline,
  onRestartReady,
}: {
  csrf: string | null
  onEvent(seq: number, event: WireEvent): void
  /**
   * The attached process stopped answering the stream (the gateway answered a
   * reconnect non-ok). No further events are coming on this key.
   */
  onStreamOffline(processKey: string): void
  /** The old gateway completed a restart and is handing off to a new one. */
  onRestartReady(info: {
    publicUrl: string | null
    localUrl: string | null
  }): void
}): Gateway {
  const [connected, setConnected] = useState(false)
  const streamRef = useRef<SessionStream | null>(null)
  const attachedKey = useRef<string | null>(null)

  // Held in refs so a new callback or a refreshed token cannot tear the
  // socket or the stream down.
  const csrfRef = useRef(csrf)
  csrfRef.current = csrf
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onStreamOfflineRef = useRef(onStreamOffline)
  onStreamOfflineRef.current = onStreamOffline
  const onRestartReadyRef = useRef(onRestartReady)
  onRestartReadyRef.current = onRestartReady

  useEffect(() => {
    const socket = connectGatewayInfo({
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onRestartReady: info => onRestartReadyRef.current(info),
    })
    return () => {
      socket.close()
      streamRef.current?.close()
      streamRef.current = null
      attachedKey.current = null
    }
  }, [])

  const attachSession = useCallback((processKey: string) => {
    if (attachedKey.current === processKey) return
    streamRef.current?.close()
    attachedKey.current = processKey
    streamRef.current = connectSessionStream(processKey, {
      onEvent: (seq, event) => onEventRef.current(seq, event),
      onOffline: () => {
        // A stream that went away for a key the user already left must not
        // disturb the one they are watching now.
        if (attachedKey.current !== processKey) return
        streamRef.current?.close()
        streamRef.current = null
        attachedKey.current = null
        onStreamOfflineRef.current(processKey)
      },
    })
  }, [])

  const detachSession = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = null
    attachedKey.current = null
  }, [])

  const command = useCallback(
    (route: SessionCommandRoute, body: WireCommand) => {
      const processKey = attachedKey.current
      const token = csrfRef.current
      if (!processKey || !token) {
        return Promise.resolve({
          ok: false,
          error: { code: 'detached', message: 'no session is attached' },
        })
      }
      return sendCommand(processKey, token, route, body)
    },
    [],
  )

  const fetchImage = useCallback(async (itemId: string) => {
    const processKey = attachedKey.current
    if (!processKey) throw new Error('no session is attached')
    const image = await fetchImageBytes(processKey, itemId)
    if (!image) throw new Error('the session has no bytes for that image')
    return image
  }, [])

  return { connected, attachSession, detachSession, command, fetchImage }
}
