import { feature } from 'bun:bundle'
import type { Attachment } from 'src/utils/attachments.js'
import type { Message, NormalizedMessage } from '../../types/message.js'
import { attachmentHasSystemReminder } from '../../utils/messages.js'

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
  'task_reminder',
  'auto_mode',
  'auto_mode_exit',
  'current_session_memory',
  'companion_intro',
  'date_change',
  'auto_compact_imminent',
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
 * True when AttachmentMessageContent renders nothing for this type, so any row
 * the attachment does produce (the injected-context reminder) owns the leading
 * margin.
 */
export function hasNoSummaryLine(type: Attachment['type']): boolean {
  return ATTACHMENTS_WITHOUT_SUMMARY_LINE.has(type)
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
  if (!hasNoSummaryLine(msg.attachment.type)) return false
  if (!showInjectedContext) return true
  return !attachmentHasSystemReminder(msg.attachment)
}
