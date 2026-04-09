import type { RemoteMessageContent } from '../utils/oauthApi.js'

export type SSHSessionCallbacks = {
  onMessage: (message: unknown) => void
  onPermissionRequest: (request: unknown, requestId: string) => void
  onConnected?: () => void
  onReconnecting?: (attempt: number, max: number) => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

/**
 * Manages the SSH session lifecycle and message passing.
 * Stub — the real implementation is not available in this build.
 */
export class SSHSessionManager {
  constructor(_callbacks: SSHSessionCallbacks) {}

  connect(): void {}
  disconnect(): void {}
  sendMessage(_content: RemoteMessageContent): boolean {
    return false
  }
  sendInterrupt(): void {}
  respondToPermissionRequest(
    _requestId: string,
    _result:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ): void {}
}
