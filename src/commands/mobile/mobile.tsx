import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { BaseText, Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { sendDaemonControl } from '../../webui/daemonControl.js'
import { readAuthFile } from '../../webui/gateway/auth.js'

type Status = 'checking' | 'starting' | 'ready' | 'error'

type Props = {
  onDone: () => void
}

function MobileQRCode({ onDone }: Props): React.ReactNode {
  const [status, setStatus] = useState<Status>('checking')
  const [url, setUrl] = useState<string>('')
  const [qrCode, setQrCode] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState<string>('')

  useEffect(() => {
    void (async () => {
      try {
        const probe = await sendDaemonControl({ kind: 'web.status' }, 2000)
        if (probe?.ok && probe.status.running) {
          const webUrl = probe.status.publicUrl ?? probe.status.url
          if (webUrl) {
            setUrl(webUrl)
            const qr = await qrToString(webUrl.toUpperCase(), {
              type: 'utf8',
              errorCorrectionLevel: 'L',
              margin: 2,
            })
            setQrCode(qr)
            setStatus('ready')
            return
          }
        }

        if (!readAuthFile()) {
          setErrorMsg(
            'No password is set. Run `claude web start` first to set one.',
          )
          setStatus('error')
          return
        }

        setStatus('starting')

        const { daemonMain } = await import('../../daemon/main.js')
        const daemonProbe = await sendDaemonControl(
          { kind: 'web.status' },
          2000,
        )
        if (!daemonProbe) {
          await daemonMain(['start'])
          for (let attempt = 0; attempt < 50; attempt++) {
            await Bun.sleep(100)
            if (await sendDaemonControl({ kind: 'web.status' }, 2000)) break
          }
        }

        const startResult = await sendDaemonControl({
          kind: 'web.start',
          options: { tunnel: 'localtunnel' },
        })
        if (!startResult?.ok) {
          setErrorMsg(
            startResult
              ? `Start failed: ${startResult.error}`
              : 'The daemon did not respond.',
          )
          setStatus('error')
          return
        }

        const webUrl =
          startResult.status.publicUrl ?? startResult.status.url
        if (!webUrl) {
          setErrorMsg('The web server started but returned no URL.')
          setStatus('error')
          return
        }

        setUrl(webUrl)
        const qr = await qrToString(webUrl.toUpperCase(), {
          type: 'utf8',
          errorCorrectionLevel: 'L',
          margin: 2,
        })
        setQrCode(qr)
        setStatus('ready')
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    })()
  }, [])

  const handleClose = useCallback(() => {
    onDone()
  }, [onDone])

  useKeybinding('confirm:no', handleClose, { context: 'Confirmation' })

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'q' || (e.ctrl && e.key === 'c')) {
      e.preventDefault()
      onDone()
    }
  }

  if (status === 'checking') {
    return (
      <Pane>
        <Box flexDirection="column" tabIndex={0} autoFocus>
          <Text dimColor>Checking web server status...</Text>
        </Box>
      </Pane>
    )
  }

  if (status === 'starting') {
    return (
      <Pane>
        <Box flexDirection="column" tabIndex={0} autoFocus>
          <Text dimColor>Starting web server and tunnel...</Text>
        </Box>
      </Pane>
    )
  }

  if (status === 'error') {
    return (
      <Pane>
        <Box
          flexDirection="column"
          tabIndex={0}
          autoFocus
          onKeyDown={handleKeyDown}
        >
          <Text color="red">{errorMsg}</Text>
          <Text> </Text>
          <Text dimColor>(esc to close)</Text>
        </Box>
      </Pane>
    )
  }

  const lines = qrCode.split('\n').filter(line => line.length > 0)

  return (
    <Pane>
      <Box
        flexDirection="column"
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
      >
        <Text> </Text>
        {lines.map((line, i) => (
          <BaseText key={i} color="#000000" backgroundColor="#ffffff">
            {line}
          </BaseText>
        ))}
        <Text> </Text>
        <Text dimColor>Scan to open the web interface on your phone</Text>
        <Text dimColor>{url}</Text>
        <Text> </Text>
        <Text dimColor>(esc to close)</Text>
      </Box>
    </Pane>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  return <MobileQRCode onDone={onDone} />
}
