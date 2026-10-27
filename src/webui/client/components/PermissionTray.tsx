import { useState } from 'react'
import type {
  WirePermissionDecision,
  WirePermissionMode,
} from '../../../session/wire.js'
import type { PermissionEntry } from '../store.js'
import { ALLOW_SET_MODES, buildAllowDecision } from '../trayViews.js'

/** The allow half of a permission decision, as this tray's controls build it. */
export type AllowControls = Extract<
  WirePermissionDecision,
  { behavior: 'allow' }
>

/**
 * Permission is the one thing that must not be missed on a phone, so it is a
 * tray on the bottom edge rather than a centred dialog: it is reachable by
 * thumb, it cannot be scrolled past, and it keeps full width at 390px.
 *
 * The answer half got the terminal's enrichments: the input pane is editable
 * (an allow can ship `updatedInput`), "stop asking" is a checkbox instead of
 * a second button, and the mode can switch with the approval — from the modes
 * the surface may set remotely, which is why bypass/dontAsk are not in the
 * picker (the surface answers those 403).
 */
export function PermissionTray({
  request,
  queued,
  onAllow,
  onDeny,
}: {
  request: PermissionEntry
  queued: number
  onAllow(decision: AllowControls): void
  onDeny(message: string): void
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [inputText, setInputText] = useState(() =>
    JSON.stringify(request.input, null, 2),
  )
  const [inputError, setInputError] = useState('')
  const [persist, setPersist] = useState(false)
  const [setMode, setSetMode] = useState<WirePermissionMode | ''>('')
  const [feedback, setFeedback] = useState('')

  function allow(): void {
    const result = buildAllowDecision({
      persist,
      setMode: setMode || null,
      editedInput: editing ? inputText : null,
      originalInput: request.input,
    })
    if (!result.ok) {
      setInputError(result.error)
      return
    }
    setInputError('')
    onAllow(result.decision)
  }

  return (
    <section
      className="tray"
      role="alertdialog"
      aria-label="Permission request"
    >
      <header className="tray__head">
        <span className="tray__tool">{request.toolName}</span>
        {queued > 1 ? (
          <span className="tray__queued">+{queued - 1} waiting</span>
        ) : null}
        <button
          type="button"
          className="tray__toggle"
          onClick={() => setEditing(v => !v)}
        >
          {editing ? 'hide input' : 'edit input'}
        </button>
      </header>

      <p className="tray__desc">{request.description}</p>
      {request.blockedPath ? (
        <p className="tray__blocked">
          outside the working directory: {request.blockedPath}
        </p>
      ) : null}

      {editing ? (
        <>
          <textarea
            className="tray__edit"
            value={inputText}
            spellCheck={false}
            onChange={event => {
              setInputText(event.target.value)
              setInputError('')
            }}
            rows={6}
          />
          {inputError ? <p className="tray__error">{inputError}</p> : null}
        </>
      ) : null}

      <textarea
        className="tray__feedback"
        placeholder="Optional: tell it what to do instead (sent on deny)"
        value={feedback}
        onChange={event => setFeedback(event.target.value)}
        rows={2}
      />

      <div className="tray__controls">
        {/* Session scope only, and labelled as such. The terminal's equivalent
            writes a durable rule to project-local settings, which a surface
            reachable over a public tunnel must not do. */}
        <label className="tray__check">
          <input
            type="checkbox"
            checked={persist}
            onChange={event => setPersist(event.target.checked)}
          />
          stop asking this tool (session only, nothing written to disk)
        </label>
        <label className="tray__mode">
          then switch to{' '}
          <select
            value={setMode}
            onChange={event =>
              setSetMode(event.target.value as WirePermissionMode | '')
            }
          >
            <option value="">(keep mode)</option>
            {ALLOW_SET_MODES.map(mode => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tray__actions">
        <button
          type="button"
          className="btn btn--deny"
          onClick={() => onDeny(feedback)}
        >
          Deny
        </button>
        <button type="button" className="btn btn--allow" onClick={allow}>
          Allow
        </button>
      </div>
    </section>
  )
}
