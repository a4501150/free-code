import { queryHaiku } from '../../services/api/claude.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { extractTextContent } from '../../utils/messages.js'
import { extractConversationText } from '../../utils/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

export type NameResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'no_text' | 'model_failed' | 'bad_response' }

export async function generateSessionName(
  messages: Message[],
  signal: AbortSignal,
): Promise<NameResult> {
  const conversationText = extractConversationText(messages)
  if (!conversationText) {
    return { ok: false, reason: 'no_text' }
  }

  try {
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([
        'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures". Return JSON with a "name" field.',
      ]),
      userPrompt: conversationText,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'rename_generate_name',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
      },
    })

    const content = extractTextContent(result.message.content)

    const response = safeParseJSON(content)
    if (
      response &&
      typeof response === 'object' &&
      'name' in response &&
      typeof (response as { name: unknown }).name === 'string'
    ) {
      return { ok: true, name: (response as { name: string }).name }
    }
    logForDebugging(
      `generateSessionName: unparseable response: ${content.slice(0, 200)}`,
      { level: 'error' },
    )
    return { ok: false, reason: 'bad_response' }
  } catch (error) {
    // Haiku timeout/rate-limit/network are expected operational failures —
    // logForDebugging, not logError. May be called frequently,
    // so errors here would flood the error file.
    logForDebugging(`generateSessionName failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    return { ok: false, reason: 'model_failed' }
  }
}
