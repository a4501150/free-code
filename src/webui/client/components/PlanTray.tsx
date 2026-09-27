import { useState } from 'react'
import type { PermissionEntry } from '../store.js'
import type { WirePermissionMode } from '../../../session/wire.js'
import { renderMarkdown } from '../markdown.js'

/**
 * The browser surface for a `ui.kind === 'plan'` request.
 *
 * The plan content rides the request's `ui`, so no disk read is involved.
 *
 * The terminal's clear-context choices are deliberately absent. Those work by
 * rejecting the tool call and starting a fresh query from the REPL, which a
 * headless session has no counterpart for.
 */

/**
 * The input an approval sends back.
 *
 * `plan` is dropped. Leaving it in makes the tool treat the plan as one the
 * user rewrote, and the model is then told "Approved Plan (edited by user)" for
 * a plan nobody touched. The tool reads the plan from disk when the input omits
 * it, which is exactly what the terminal relies on by sending an empty object.
 * This client cannot send an empty one, because the route reads an absent
 * `updatedInput` as "use the original input".
 */
export function approvalInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { plan: _plan, ...rest } = input
  return rest
}

export function PlanTray({
  request,
  planContent,
  queued,
  onApprove,
  onKeepPlanning,
}: {
  request: PermissionEntry
  /** `request.ui.planContent`. */
  planContent: string
  queued: number
  /**
   * One round trip: the allow carries `setMode`, which switches the permission
   * mode as part of answering, the same ordered effect the terminal achieves by
   * applying the mode before the tool runs.
   */
  onApprove(mode: WirePermissionMode): void
  onKeepPlanning(feedback: string): void
}): React.ReactElement {
  const [feedback, setFeedback] = useState('')

  return (
    <section className="tray" role="alertdialog" aria-label="Plan approval">
      <header className="tray__head">
        <span className="tray__tool">plan</span>
        {queued > 1 ? (
          <span className="tray__queued">+{queued - 1} waiting</span>
        ) : null}
      </header>

      {planContent ? (
        <div
          className="tray__plan md"
          // renderMarkdown sanitizes, and the session is the only writer, but
          // every transcript string is treated as untrusted regardless.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(planContent) }}
        />
      ) : (
        <p className="tray__desc">No plan was recorded. Approve to proceed.</p>
      )}

      <textarea
        className="tray__feedback"
        placeholder="Optional: what to change (sent when you keep planning)"
        value={feedback}
        onChange={event => setFeedback(event.target.value)}
        rows={2}
      />

      <div className="tray__actions tray__actions--stacked">
        <button
          type="button"
          className="btn btn--allow"
          onClick={() => onApprove('acceptEdits')}
        >
          approve, auto-accept edits
        </button>
        <button
          type="button"
          className="btn btn--allow"
          onClick={() => onApprove('default')}
        >
          approve, ask before each edit
        </button>
        <button
          type="button"
          className="btn btn--deny"
          onClick={() => onKeepPlanning(feedback)}
        >
          keep planning
        </button>
      </div>
    </section>
  )
}
