import type { Socket } from 'net'
import { MAX_ATTACH_LINE_BYTES } from '../protocol/attachSchemas.js'

export type NdjsonHandlers = {
  onLine: (line: string) => void
  onError: (code: string, message: string) => void
  onClose: () => void
}

/**
 * Newline-delimited JSON over a socket. A line longer than
 * MAX_ATTACH_LINE_BYTES fails the connection rather than buffering without
 * bound, because the peer is local but not necessarily well behaved.
 */
export function attachNdjsonReader(
  socket: Socket,
  handlers: NdjsonHandlers,
): void {
  let buffer = ''

  socket.setEncoding('utf-8')

  socket.on('data', (chunk: string) => {
    buffer += chunk

    if (Buffer.byteLength(buffer) > MAX_ATTACH_LINE_BYTES) {
      handlers.onError('line_too_long', 'NDJSON line exceeded the size limit')
      socket.destroy()
      buffer = ''
      return
    }

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) handlers.onLine(line)
      newline = buffer.indexOf('\n')
    }
  })

  socket.on('error', err => {
    handlers.onError('socket_error', err.message)
  })

  socket.on('close', handlers.onClose)
}

export function writeNdjson(socket: Socket, value: unknown): void {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(value)}\n`)
}
