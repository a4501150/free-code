/**
 * The hosted mirror of the REPL's /resume ownership-conflict path.
 *
 * Adopting a session another live process already holds makes both append
 * to one transcript and share every store keyed on the session id. The
 * classic REPL opens the ResumeSessionConflictDialog in its tool-JSX slot;
 * a hosted session has no dialog slot of its own, so the conflict rides the
 * same local-jsx handoff every dialog command uses (session/localDialogs):
 * the dialog JSX goes to the store, the hosting terminal's viewer mounts it
 * in its modal slot, and the choice comes back through the promise. A
 * remote attach shows nothing and the command stays with the hosting
 * terminal — the local-UX rule the /tasks mirror already draws.
 *
 * Deviation documented with the `resume` rpc it feeds: the SessionEnd/
 * SessionStart hook cycle a classic /resume runs does not fire here — a
 * hosted resume is a client action on a live session, not the terminal
 * session cycling.
 */
import * as React from 'react'
import { readAttachDescriptor } from '../server/descriptor.js'
import {
  ResumeSessionConflictDialog,
  type ResumeSessionConflictChoice,
} from '../components/ResumeSessionConflictDialog.js'
import { checkResumeSessionOwnership } from '../utils/sessionRestore.js'
import type { LocalDialogStore } from '../session/localDialogs.js'

/**
 * Returns 'none' when nobody else holds the session, otherwise the user's
 * choice from the conflict dialog. Mounted through the dialog store with
 * the exact clear/replace sequence the REPL's useReplSessionResume uses,
 * so the local-command latch behaves identically.
 */
export async function resolveResumeConflictForHost(
  dialogs: LocalDialogStore,
  sessionId: string,
): Promise<ResumeSessionConflictChoice | 'none'> {
  const conflict = await checkResumeSessionOwnership(sessionId)
  if (!conflict) return 'none'
  const holder = conflict.holders[0]
  const choice = await new Promise<ResumeSessionConflictChoice>(resolve => {
    dialogs.set({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    })
    dialogs.set({
      jsx: (
        <ResumeSessionConflictDialog
          sessionId={conflict.sessionId}
          holders={conflict.holders}
          holderAttachable={
            holder ? readAttachDescriptor(holder.pid).ok : false
          }
          onChoice={resolve}
        />
      ),
      shouldHidePromptInput: true,
    })
  })
  dialogs.set({
    jsx: null,
    shouldHidePromptInput: false,
    clearLocalJSX: true,
  })
  return choice
}
