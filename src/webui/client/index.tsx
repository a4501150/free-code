import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type Probe = {
  label: string
  status: 'pending' | 'ok' | 'failed'
  detail?: string
}

/**
 * Phase 0 shell. Its only job is to prove that a React bundle embedded in the
 * compiled binary boots in a browser and can open a WebSocket back to the
 * gateway. The real UI replaces this in phase 4.
 */
function App(): React.ReactElement {
  const [probes, setProbes] = useState<Probe[]>([
    { label: 'assets', status: 'ok', detail: 'bundle booted' },
    { label: 'websocket', status: 'pending' },
  ])

  useEffect(() => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const socket = new WebSocket(url)

    const settle = (status: 'ok' | 'failed', detail: string): void => {
      setProbes(prev =>
        prev.map(p => (p.label === 'websocket' ? { ...p, status, detail } : p)),
      )
    }

    socket.addEventListener('message', event => {
      settle('ok', String(event.data).slice(0, 64))
    })
    socket.addEventListener('error', () => {
      settle('failed', 'connection error')
    })

    return () => {
      socket.close()
    }
  }, [])

  return (
    <main className="boot">
      <h1 className="boot__title">claude web</h1>
      <ul className="boot__probes">
        {probes.map(probe => (
          <li key={probe.label} className={`boot__probe is-${probe.status}`}>
            <span className="boot__label">{probe.label}</span>
            <span className="boot__detail">{probe.detail ?? '…'}</span>
          </li>
        ))}
      </ul>
    </main>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
