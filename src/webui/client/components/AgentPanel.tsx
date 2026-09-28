import { useEffect, useMemo, useState } from 'react'
import type { WireItem, WireTranscriptSnapshot } from '../../../session/wire.js'
import { Transcript } from './Transcript.js'

/**
 * The sidechain drill-down: one agent's transcript in a slide-over, rendered
 * by the same Transcript component as the main view — the panel is a second
 * source of items, not a second renderer.
 */
export type AgentPanelState = {
  agentId: string
  state: 'loading' | 'ready' | 'failed'
  snapshot?: WireTranscriptSnapshot
  error?: string
}

export function AgentPanel({
  panel,
  onClose,
}: {
  panel: AgentPanelState
  onClose(): void
}): React.ReactElement {
  const { items, order } = useMemo(() => {
    const snapshot = panel.snapshot
    if (!snapshot)
      return { items: new Map<string, WireItem>(), order: [] as string[] }
    return {
      items: new Map(snapshot.items.map(item => [item.id, item])),
      order: [...snapshot.order],
    }
  }, [panel.snapshot])

  // Escape closes the panel. It must win over the drawer's own handler when
  // both are open, and the drawer is behind this one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      className="agent-panel"
      role="dialog"
      aria-label={`agent ${panel.agentId.slice(0, 8)}`}
    >
      <header className="agent-panel__head">
        <span className="agent-panel__title">
          agent <code>{panel.agentId.slice(0, 8)}</code>
        </span>
        <button
          type="button"
          className="agent-panel__close"
          aria-label="Close agent transcript"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {panel.state === 'loading' ? (
        <p className="agent-panel__note">loading…</p>
      ) : panel.state === 'failed' ? (
        <p className="agent-panel__note">{panel.error ?? 'unavailable'}</p>
      ) : (
        <div className="agent-panel__body">
          <Transcript
            items={items}
            order={order}
            followSignal={0}
            // Sidechain images are rare and the panel has no session context
            // to fetch them through; the row shows the placeholder text.
            onFetchImage={() =>
              Promise.reject(new Error('images are not shown in the side view'))
            }
          />
        </div>
      )}
    </aside>
  )
}
