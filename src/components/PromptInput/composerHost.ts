/**
 * Session-side action seam for the composer (PromptInput), following the
 * injectable-data-source pattern of panels/commandPalette/dataSources.ts.
 *
 * The composer reads session state from the AppState store and session
 * module services (command queue, history files, speculation, agent-view
 * helpers) directly — the shared-process store contract: mount the
 * component only where the AppState store it sees IS the session's store
 * (the classic REPL; the local hosted viewer mounts on the session's).
 * What must NOT be direct are the REPL-owned closures that reach into the
 * query loop — they arrive here, as a single interface a host implements
 * once. A wire-fed host maps each member onto its transport (a submit
 * command, an agent-id'd prompt, an rpc, or a local no-op).
 */
import type { ActiveSpeculationState } from '../../services/PromptSuggestion/speculation.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'

/** An active speculation the submitted input accepts. The host's own store
 *  mutator is not carried — the host has it. */
export type ComposerSpeculationAccept = {
  state: ActiveSpeculationState
  speculationSessionTimeSavedMs: number
}

/** The background agent a submission is steered to. A wire host needs the
 *  id (agent-routed prompt command); status rides along for hosts that
 *  branch on running-vs-idle. */
export type ComposerAgentTarget = {
  id: string
  status: string
}

export type ComposerHost = {
  /** Leader submission — the classic routes into handlePromptSubmit; a
   *  wire host sends its prompt command. */
  submit(
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: ComposerSpeculationAccept,
    options?: { fromKeybinding?: boolean },
  ): Promise<void>
  /** Steer the viewed background agent instead of the leader. */
  submitToAgent(
    input: string,
    target: ComposerAgentTarget,
    helpers: PromptInputHelpers,
  ): Promise<void>
  /** Debounced keystroke prefetch of the input-scoped attachment trio
   *  (@-mentions, MCP resources, agent mentions). The classic forwards to
   *  startUserInputAttachmentPrefetch; a wire host may no-op or rpc. */
  prefetchAttachments(
    value: string,
    messages: Message[],
    mainLoopModel: string,
  ): void
  /** Compute, apply and side-effect a permission-mode cycle, including the
   *  recheck of queued permission prompts. */
  cyclePermissionMode(ctx: ToolPermissionContext): void
}
