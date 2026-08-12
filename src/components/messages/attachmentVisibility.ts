import { feature } from 'bun:bundle'
import type { Attachment } from 'src/utils/attachments.js'
import type {
  Message,
  NormalizedMessage,
  RenderableMessage,
} from '../../types/message.js'
import {
  attachmentHasSystemReminder,
  getContentText,
  isSystemReminderText,
  isTaskNotificationText,
} from '../../utils/messages.js'

/**
 * Attachment types that AttachmentMessageContent renders as `null` — they
 * contribute no summary line of their own. They are not necessarily invisible:
 * when injected context is shown, AttachmentMessage wraps them in a system
 * reminder row, and that row is then the attachment's only row.
 *
 * Sync is enforced by TypeScript: AttachmentMessage's switch `default:` branch
 * asserts `attachment.type satisfies AttachmentWithoutSummaryLine`. Adding a
 * new Attachment type without either a case or an entry here will fail
 * typecheck.
 */
const TYPES_WITHOUT_SUMMARY_LINE = [
  'hook_success',
  'hook_additional_context',
  'hook_cancelled',
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'structured_output',
  'team_context',
  'deferred_tools_delta',
  'mcp_tools_delta',
  'mcp_instructions_delta',
  'token_usage',
  'ultrathink_effort',
  'max_turns_reached',
  'auto_mode',
  'auto_mode_exit',
  'current_session_memory',
  'companion_intro',
  'date_change',
  'terminal_focus',
  'auto_compact_imminent',
  'stale_task_list',
] as const satisfies readonly Attachment['type'][]

// Exhaustiveness type: keep 'verify_plan_reminder' in the type union so the
// satisfies AttachmentWithoutSummaryLine assertion in AttachmentMessage's
// switch default still passes when VERIFY_PLAN is compiled out.
export type AttachmentWithoutSummaryLine =
  | (typeof TYPES_WITHOUT_SUMMARY_LINE)[number]
  | 'verify_plan_reminder'

const ATTACHMENTS_WITHOUT_SUMMARY_LINE: ReadonlySet<Attachment['type']> =
  new Set<Attachment['type']>([
    ...TYPES_WITHOUT_SUMMARY_LINE,
    ...(feature('VERIFY_PLAN') ? ['verify_plan_reminder' as const] : []),
  ])

/**
 * True when AttachmentMessageContent renders nothing for this attachment, so
 * any row the attachment does produce (the injected-context reminder) owns the
 * leading margin.
 */
export function rendersNoSummaryLine(attachment: Attachment): boolean {
  if (ATTACHMENTS_WITHOUT_SUMMARY_LINE.has(attachment.type)) return true
  // Types that are absent from the set above but still hit an early
  // `return null` in AttachmentMessageContent's switch. Only conditions that
  // are stable per attachment belong here — a verbose-dependent branch would
  // make the margin flip with ctrl+r.
  switch (attachment.type) {
    case 'agent_listing_delta':
      return attachment.isInitial || attachment.addedTypes.length === 0
    case 'skill_listing':
      return attachment.isInitial
    case 'invoked_skills':
      return attachment.skills.length === 0
    default:
      return false
  }
}

/**
 * A queued task notification renders its own detail through
 * UserAgentNotificationMessage. normalizeAttachmentForAPI additionally wraps it
 * in a system reminder, so AttachmentMessage skips the generic reminder row.
 */
export function isQueuedTaskNotification(attachment: Attachment): boolean {
  if (attachment.type !== 'queued_command') return false
  const text =
    typeof attachment.prompt === 'string'
      ? attachment.prompt
      : getContentText(attachment.prompt) || ''
  return isTaskNotificationText(text)
}

/** Whether this row's last rendered element is a collapsed injected-context row. */
function endsWithInjectedContextRow(
  msg: RenderableMessage,
  showInjectedContext: boolean,
): boolean {
  if (!showInjectedContext) return false
  if (msg.type === 'attachment') {
    return (
      !isQueuedTaskNotification(msg.attachment) &&
      attachmentHasSystemReminder(msg.attachment)
    )
  }
  if (msg.type !== 'user' || !msg.isMeta) return false
  const block = msg.message.content[0]
  return block?.type === 'text' && isSystemReminderText(block.text)
}

/** Whether this row's first rendered element is a collapsed injected-context row. */
function startsWithInjectedContextRow(
  msg: RenderableMessage,
  showInjectedContext: boolean,
): boolean {
  if (!endsWithInjectedContextRow(msg, showInjectedContext)) return false
  return msg.type !== 'attachment' || rendersNoSummaryLine(msg.attachment)
}

/**
 * Injected-context rows pack together: only the first of a run takes the blank
 * line above it, so a session opening with several reminders reads as one
 * block instead of a ladder of alternating gaps.
 */
export function isInjectedContextContinuation(
  msg: RenderableMessage,
  previous: RenderableMessage | undefined,
  showInjectedContext: boolean,
): boolean {
  if (!previous) return false
  return (
    startsWithInjectedContextRow(msg, showInjectedContext) &&
    endsWithInjectedContextRow(previous, showInjectedContext)
  )
}

/**
 * Whether the transcript should drop this message entirely. Callers must filter
 * BEFORE counting and before the render cap, so invisible entries don't inflate
 * the "N messages" count or eat into the render budget (CC-724).
 *
 * An attachment with no summary line is still kept when injected context is
 * visible and it actually contributes a system reminder — that reminder becomes
 * the row's collapsible body. Types that contribute nothing
 * (command_permissions, hook_cancelled, structured_output, …) stay hidden.
 */
export function shouldHideAttachmentInUI(
  msg: Message | NormalizedMessage,
  showInjectedContext: boolean,
): boolean {
  if (msg.type !== 'attachment') return false
  if (!rendersNoSummaryLine(msg.attachment)) return false
  if (!showInjectedContext) return true
  return !attachmentHasSystemReminder(msg.attachment)
}
