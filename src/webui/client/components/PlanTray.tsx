import { useState } from 'react'
import type {
  WebPermissionMode,
  WebPermissionRequest,
} from '../../protocol/attachSchemas.js'
import { renderMarkdown } from '../markdown.js'

/**
 * The browser surface for ExitPlanMode.
 *
 * `plan` is already on the request: `normalizeToolInput` injects it from disk
 * as the assistant message arrives, which is well before any permission check.
 *
 * The terminal's clear-context choices are deliberately absent. Those work by
 * rejecting the tool call and starting a fresh query from the REPL, which a
 * headless session has no counterpart for.
 */

/**
 * The input an approval sends back.
 *
 * `plan` is dropped. Leaving it in makes `ExitPlanModeTool` treat the plan as
 * one the user rewrote, and the model is then told "Approved Plan (edited by
 * user)" for a plan nobody touched. The tool reads the plan from disk when the
 * input omits it, which is exactly what the terminal relies on by sending an
 * empty object. This client cannot send an empty one, because the bridge reads
 * that as "use the original input".
 */
export function approvalInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { plan: _plan, ...rest } = input
  return rest
}

export function PlanTray({
  request,
  queued,
  onApprove,
  onKeepPlanning,
}: {
  request: WebPermissionRequest
  queued: number
  /**
   * The mode is sent as its own request before the allow, because an allow
   * cannot carry a permission update. That ordering matches the terminal,
   * where the mode is applied before the tool runs.
   */
  onApprove(mode: WebPermissionMode): void
  onKeepPlanning(feedback: string): void
}): React.ReactElement {
  const [feedback, setFeedback] = useState('')
  const plan = typeof request.input.plan === 'string' ? request.input.plan : ''

  return (
    <section className="tray" role="alertdialog" aria-label="Plan approval">
      <header className="tray__head">
        <span className="tray__tool">plan</span>
        {queued > 1 ? (
          <span className="tray__queued">+{queued - 1} waiting</span>
        ) : null}
      </header>

      {plan ? (
        <div
          className="tray__plan md"
          // renderMarkdown sanitizes, and the session is the only writer, but
          // every transcript string is treated as untrusted regardless.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }}
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
