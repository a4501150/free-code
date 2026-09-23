/**
 * Codex/ChatGPT login UI — drives startCodexLogin (browser PKCE flow with
 * a local callback server on port 1455, manual paste fallback). The flow
 * itself lives in src/services/oauth/codex-client.ts; this component only
 * renders its states.
 */
import React, { useEffect, useRef, useState } from 'react'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { Box, Link, Text } from '../ink.js'
import { startCodexLogin } from '../services/oauth/logins/codex.js'
import { errorMessage } from '../utils/errors.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'

type Props = {
  onDone(): void
  startingMessage?: string
}

type CodexFlowStatus =
  | { state: 'starting' }
  | { state: 'waiting'; url: string }
  | { state: 'success' }
  | { state: 'error'; message: string }

const PASTE_HERE_MSG = 'Paste code here if prompted > '

export function CodexOAuthFlow({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  const [status, setStatus] = useState<CodexFlowStatus>({ state: 'starting' })
  const [pastedCode, setPastedCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const resolveManualRef = useRef<((input: string) => void) | null>(null)
  const runningRef = useRef(false)
  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1

  useKeybinding(
    'confirm:yes',
    () => {
      if (status.state === 'success') {
        onDone()
      } else if (status.state === 'error') {
        setPastedCode('')
        setStatus({ state: 'starting' })
      }
    },
    {
      context: 'Confirmation',
      isActive: status.state === 'success' || status.state === 'error',
    },
  )

  useEffect(() => {
    if (status.state !== 'starting' || runningRef.current) return
    runningRef.current = true
    void (async () => {
      try {
        await startCodexLogin(
          async url => setStatus({ state: 'waiting', url }),
          () =>
            new Promise<string>(resolve => {
              resolveManualRef.current = resolve
            }),
        )
        setStatus({ state: 'success' })
      } catch (err) {
        setStatus({ state: 'error', message: errorMessage(err) })
      } finally {
        runningRef.current = false
        // Release a manual-paste promise that never received input.
        resolveManualRef.current?.('')
        resolveManualRef.current = null
      }
    })()
  }, [status.state])

  return (
    <Box flexDirection="column" gap={1}>
      {startingMessage && <Text bold>{startingMessage}</Text>}
      {status.state === 'starting' && (
        <Box>
          <Spinner />
          <Text>Opening browser to sign in…</Text>
        </Box>
      )}
      {status.state === 'waiting' && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text dimColor>
              Browser didn&apos;t open? Sign in with the url below:
            </Text>
            <Link url={status.url}>
              <Text dimColor>{status.url}</Text>
            </Link>
          </Box>
          <Box>
            <Text>{PASTE_HERE_MSG}</Text>
            <TextInput
              value={pastedCode}
              onChange={setPastedCode}
              onSubmit={(value: string) => {
                resolveManualRef.current?.(value)
                resolveManualRef.current = null
              }}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={textInputColumns}
              mask="*"
            />
          </Box>
        </Box>
      )}
      {status.state === 'success' && (
        <Box flexDirection="column">
          <Text color="success">
            Login successful. Press <Text bold>Enter</Text> to continue…
          </Text>
        </Box>
      )}
      {status.state === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color="error">Login error: {status.message}</Text>
          <Box marginTop={1}>
            <Text color="permission">
              Press <Text bold>Enter</Text> to retry.
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
