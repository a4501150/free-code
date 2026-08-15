import { useState } from 'react'
import type { WebPermissionRequest } from '../../protocol/attachSchemas.js'

/**
 * Permission is the one thing that must not be missed on a phone, so it is a
 * tray on the bottom edge rather than a centred dialog: it is reachable by
 * thumb, it cannot be scrolled past, and it keeps full width at 390px.
 */
export function PermissionTray({
  request,
  queued,
  onAllow,
  onDeny,
}: {
  request: WebPermissionRequest
  queued: number
  /** `persist` stops this tool asking again for the rest of the session. */
  onAllow(persist: boolean): void
  onDeny(message: string): void
}): React.ReactElement {
  const [showInput, setShowInput] = useState(false)
  const [feedback, setFeedback] = useState('')

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
          onClick={() => setShowInput(v => !v)}
        >
          {showInput ? 'hide input' : 'show input'}
        </button>
      </header>

      <p className="tray__desc">{request.description}</p>
      {request.blockedPath ? (
        <p className="tray__blocked">
          outside the working directory: {request.blockedPath}
        </p>
      ) : null}

      {showInput ? (
        <pre className="tray__pre">
          {JSON.stringify(request.input, null, 2)}
        </pre>
      ) : null}

      <textarea
        className="tray__feedback"
        placeholder="Optional: tell it what to do instead (sent on deny)"
        value={feedback}
        onChange={event => setFeedback(event.target.value)}
        rows={2}
      />

      <div className="tray__actions">
        <button
          type="button"
          className="btn btn--deny"
          onClick={() => onDeny(feedback)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn--allow"
          onClick={() => onAllow(false)}
        >
          Allow
        </button>
        {/* Session scope only, and labelled as such. The terminal's equivalent
            writes a durable rule to project-local settings, which a surface
            reachable over a public tunnel must not do. */}
        <button
          type="button"
          className="btn btn--allow"
          title="This session only. Nothing is written to disk."
          onClick={() => onAllow(true)}
        >
          Allow always
        </button>
      </div>
    </section>
  )
}
