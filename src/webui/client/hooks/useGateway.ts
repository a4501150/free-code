import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectGateway,
  type CommandResult,
  type GatewaySocket,
  type ServerFrame,
} from '../api.js'
import type {
  AttachEventBody,
  AttachRequestBody,
} from '../../protocol/attachSchemas.js'

export type Gateway = {
  connected: boolean
  attach(processKey: string): void
  send(body: AttachRequestBody): void
  request(body: AttachRequestBody): Promise<CommandResult>
}

/**
 * Owns the one websocket for the whole app.
 *
 * Deliberately narrow: it does not poll, and it performs no HTTP. The caller
 * decides what an event means.
 */
export function useGateway({
  csrf,
  onEvent,
}: {
  csrf: string | null
  onEvent(seq: number, event: AttachEventBody): void
}): Gateway {
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<GatewaySocket | null>(null)

  // Held in a ref so a new callback identity cannot tear the socket down.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!csrf) return
    const socket = connectGateway({
      csrf,
      onFrame: (frame: ServerFrame) => {
        if (frame.type === 'event') onEventRef.current(frame.seq, frame.event)
      },
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    })
    socketRef.current = socket
    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [csrf])

  const attach = useCallback((processKey: string) => {
    socketRef.current?.attach(processKey)
  }, [])

  const send = useCallback((body: AttachRequestBody) => {
    socketRef.current?.send(body)
  }, [])

  const request = useCallback((body: AttachRequestBody) => {
    const socket = socketRef.current
    if (!socket) return Promise.reject(new Error('not connected'))
    return socket.request(body)
  }, [])

  return { connected, attach, send, request }
}
