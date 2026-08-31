import { describe, expect, test } from 'bun:test'
import {
  formatUserContextMessageContent,
  prependUserContext,
} from '../../src/utils/contextInjection.js'
import {
  createUserMessage,
  extractSystemReminderBody,
  getAttachmentSystemReminderBodies,
  isSystemReminderText,
  isTaskNotificationText,
  normalizeMessages,
  shouldShowUserMessage,
  wrapInSystemReminder,
} from '../../src/utils/messages.js'
import {
  isInjectedContextContinuation,
  rendersNoSummaryLine,
  shouldHideAttachmentInUI,
} from '../../src/components/messages/attachmentVisibility.js'
import type { Attachment } from '../../src/utils/attachments.js'
import type { NormalizedMessage } from '../../src/types/message.js'
import { USER_CONTEXT_ROW_UUID } from '../../src/constants/messages.js'

function normalizedUser(
  content: string,
  opts: { isMeta?: boolean } = {},
): NormalizedMessage {
  const msg = createUserMessage({ content, isMeta: opts.isMeta })
  return normalizeMessages([msg])[0]!
}

function attachmentMessage(attachment: Attachment): NormalizedMessage {
  return {
    type: 'attachment',
    uuid: '00000000-0000-4000-8000-0000000000aa',
    timestamp: new Date().toISOString(),
    attachment,
  } as NormalizedMessage
}

describe('tag detection', () => {
  test('matches only at the start of the text', () => {
    expect(
      isSystemReminderText('<system-reminder>\nhi\n</system-reminder>'),
    ).toBe(true)
    expect(
      isTaskNotificationText('<task-notification>\n</task-notification>'),
    ).toBe(true)
    // A prompt that merely discusses the tag must stay a prompt, or the
    // synthetic renderer swallows what the user typed.
    expect(
      isSystemReminderText('why does <system-reminder> show up in my logs?'),
    ).toBe(false)
  })

  test('extracts and trims the body, rejecting an empty one', () => {
    expect(extractSystemReminderBody(wrapInSystemReminder('  body  '))).toBe(
      'body',
    )
    expect(extractSystemReminderBody(wrapInSystemReminder('   '))).toBeNull()
    expect(extractSystemReminderBody('plain prompt')).toBeNull()
  })
})

describe('shouldShowUserMessage', () => {
  test('reveals a meta reminder only when injected context is on', () => {
    const msg = normalizedUser(wrapInSystemReminder('auto mode active'), {
      isMeta: true,
    })
    expect(shouldShowUserMessage(msg, false, true)).toBe(true)
    expect(shouldShowUserMessage(msg, false, false)).toBe(false)
  })

  test('reveals a meta task notification when injected context is on', () => {
    const msg = normalizedUser(
      '<task-notification>\n<summary>done</summary>\n</task-notification>',
      { isMeta: true },
    )
    expect(shouldShowUserMessage(msg, false, true)).toBe(true)
    expect(shouldShowUserMessage(msg, false, false)).toBe(false)
  })

  test('unrelated meta messages stay hidden either way', () => {
    const msg = normalizedUser('<tick>1</tick>', { isMeta: true })
    expect(shouldShowUserMessage(msg, false, true)).toBe(false)
    expect(shouldShowUserMessage(msg, false, false)).toBe(false)
  })

  test('non-meta messages are unaffected', () => {
    const msg = normalizedUser('hello')
    expect(shouldShowUserMessage(msg, false, true)).toBe(true)
    expect(shouldShowUserMessage(msg, false, false)).toBe(true)
  })
})

describe('attachment reminder eligibility', () => {
  test('a reminder-bearing attachment is kept when injected context is on', () => {
    const msg = attachmentMessage({
      type: 'date_change',
      previousDate: '2026-08-04',
      currentDate: '2026-08-05',
    } as Attachment)

    expect(getAttachmentSystemReminderBodies(msg.attachment).length).toBe(1)
    expect(shouldHideAttachmentInUI(msg, true)).toBe(false)
    // Off, it keeps the pre-existing CC-724 behavior.
    expect(shouldHideAttachmentInUI(msg, false)).toBe(true)
  })

  test('an attachment with no reminder text stays hidden both ways', () => {
    const msg = attachmentMessage({
      type: 'command_permissions',
      allowedTools: [],
    } as unknown as Attachment)

    expect(getAttachmentSystemReminderBodies(msg.attachment)).toEqual([])
    expect(shouldHideAttachmentInUI(msg, true)).toBe(true)
    expect(shouldHideAttachmentInUI(msg, false)).toBe(true)
  })

  test('a non-attachment message is never dropped by this predicate', () => {
    const msg = normalizedUser('hello')
    expect(shouldHideAttachmentInUI(msg, true)).toBe(false)
    expect(shouldHideAttachmentInUI(msg, false)).toBe(false)
  })

  test('an attachment whose only content is conditional renders no summary line', () => {
    // AttachmentMessageContent returns null for both of these at session
    // start, so their reminder row is the attachment's only row and owns the
    // blank line above it.
    expect(
      rendersNoSummaryLine({
        type: 'agent_listing_delta',
        isInitial: true,
        addedTypes: [],
      } as unknown as Attachment),
    ).toBe(true)
    expect(
      rendersNoSummaryLine({
        type: 'agent_listing_delta',
        isInitial: false,
        addedTypes: ['explore'],
      } as unknown as Attachment),
    ).toBe(false)
    expect(
      rendersNoSummaryLine({
        type: 'skill_listing',
        isInitial: true,
        skillCount: 3,
      } as unknown as Attachment),
    ).toBe(true)
    expect(
      rendersNoSummaryLine({
        type: 'skill_listing',
        isInitial: false,
        skillCount: 3,
      } as unknown as Attachment),
    ).toBe(false)
  })
})

describe('plan mode design instructions', () => {
  function getPlanModeReminder(planAgentEnabled?: boolean): string {
    return getAttachmentSystemReminderBodies({
      type: 'plan_mode',
      reminderType: 'full',
      planFilePath: '/plans/example.md',
      planExists: false,
      renderContext: {
        agentCount: 1,
        exploreAgentCount: 1,
        interviewPhase: false,
        planAgentEnabled,
        readOnlyToolNames: 'FileRead',
      },
    })[0]!
  }

  test('requests a Plan agent when the built-in agent is enabled', () => {
    expect(getPlanModeReminder(true)).toContain('Launch Plan agent(s)')
  })

  test('keeps design in the main model when the Plan agent is disabled', () => {
    const reminder = getPlanModeReminder(false)

    expect(reminder).toContain('Design the implementation approach yourself')
    expect(reminder).not.toContain('Launch Plan agent(s)')
  })

  test('treats an older context without the availability flag as disabled', () => {
    expect(getPlanModeReminder()).not.toContain('Launch Plan agent(s)')
  })
})

describe('injected-context row spacing', () => {
  const reminderRow = () =>
    normalizedUser(wrapInSystemReminder('auto mode active'), { isMeta: true })

  test('a run of reminder rows packs together', () => {
    expect(
      isInjectedContextContinuation(reminderRow(), reminderRow(), true),
    ).toBe(true)
  })

  test('the first row of a run keeps its blank line', () => {
    expect(
      isInjectedContextContinuation(
        reminderRow(),
        normalizedUser('hello'),
        true,
      ),
    ).toBe(false)
    expect(isInjectedContextContinuation(reminderRow(), undefined, true)).toBe(
      false,
    )
  })

  test('an ordinary prompt after a reminder keeps its blank line', () => {
    expect(
      isInjectedContextContinuation(
        normalizedUser('hello'),
        reminderRow(),
        true,
      ),
    ).toBe(false)
  })

  test('nothing packs when the rows are not shown', () => {
    expect(
      isInjectedContextContinuation(reminderRow(), reminderRow(), false),
    ).toBe(false)
  })
})

describe('request-only user context', () => {
  const context = {
    claudeMd: 'line one\nline two',
    currentDate: "Today's date is 2026-08-05.",
  }

  // The display row is built from this formatter while requests keep going
  // through prependUserContext. If the two ever diverge, the transcript would
  // be showing something other than what was sent.
  test('the display text is byte-identical to what the request sends', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const sent = prependUserContext([], context)
      expect(sent).toHaveLength(1)
      const sentContent = sent[0]!
      expect(sentContent.type).toBe('user')
      const text =
        sentContent.type === 'user' &&
        typeof sentContent.message.content === 'string'
          ? sentContent.message.content
          : null

      expect(text).toBe(formatUserContextMessageContent(context))
    } finally {
      process.env.NODE_ENV = previous
    }
  })

  test('empty context produces no row and no request message', () => {
    expect(formatUserContextMessageContent({})).toBeNull()
  })

  test('the row is identifiable so it can be labelled apart from reminders', () => {
    // Message.tsx labels this row "Session context"; every other injected row
    // falls back to "System reminder". The shared UUID is the only signal.
    expect(USER_CONTEXT_ROW_UUID).toBe('00000000-0000-4000-8000-000000000001')
  })

  test('the formatter output is a system reminder, so it renders as one', () => {
    const text = formatUserContextMessageContent(context)!
    expect(isSystemReminderText(text)).toBe(true)
    expect(extractSystemReminderBody(text)).toContain('line two')
  })
})
