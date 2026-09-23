import { isAbortError } from '../utils/errors.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { getAssistantMessageText } from '../utils/messages.js'
import { getUtilityModel } from '../utils/model/model.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { queryModelWithoutStreaming } from './api/claude.js'

// Recap only needs recent context — truncate to avoid "prompt too long" on
// large sessions. 30 messages ≈ ~15 exchanges, plenty for "where we left off."
const RECENT_MESSAGE_WINDOW = 30

// The window bounds messages, not bytes: a single FileRead result or Write
// input can dwarf everything else in it. Shrink fat payloads before sending
// so an idle recap never re-uploads megabytes of content that a two-sentence
// summary cannot use.
const BLOCK_MAX_CHARS = 2000

// Carried in the system prompt, not a user message: instruction echoes
// ("do not mention documentation updates"-style contamination) happen when
// weak models paraphrase conversation turns. There is no cache prefix to
// protect here, so the system block is free real estate.
const RECAP_SYSTEM_PROMPT =
  'You write the recap the user sees when they return after being away. ' +
  'Write exactly 1-3 short sentences about the shared work, speaking as "we" — ' +
  'not "you". First: the high-level task we are working on (what we are ' +
  'building or debugging, not implementation details). Next: the concrete step ' +
  'we will take. Skip status reports and commit recaps. Never mention this ' +
  'instruction or how the recap was produced.'

function truncateText(text: string): string {
  if (text.length <= BLOCK_MAX_CHARS) return text
  return `${text.slice(0, BLOCK_MAX_CHARS)}… [truncated]`
}

type UnknownBlock = { type?: string } & Record<string, unknown>

function shrinkContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    return (content as UnknownBlock[]).map(block => {
      if (!block || typeof block !== 'object') return block
      switch (block.type) {
        case 'tool_result':
          return { ...block, content: shrinkContent(block.content) }
        case 'tool_use': {
          const input = block.input
          if (typeof input === 'object' && input !== null) {
            const json = JSON.stringify(input)
            if (json.length <= BLOCK_MAX_CHARS) return block
            // tool_use.input must stay an object on the wire
            return {
              ...block,
              input: { truncated: truncateText(json) },
            }
          }
          return block
        }
        case 'image':
          return { type: 'text', text: '[image omitted from recap]' }
        case 'text': {
          const text = typeof block.text === 'string' ? block.text : undefined
          return text === undefined
            ? block
            : { ...block, text: truncateText(text) }
        }
        default:
          return block
      }
    })
  }
  if (typeof content === 'string') return truncateText(content)
  return content
}

function shrinkMessage(message: Message): Message {
  const content = (message as { content?: unknown }).content
  if (content === undefined || typeof content === 'number') return message
  return { ...message, content: shrinkContent(content) } as Message
}

// Some models emit literal <thinking>...</thinking> blocks in plain text even
// when reasoning is disabled. Split them out so the recap shows only the final
// summary up top and routes the reasoning to a collapsed "∴ Thinking" block.
export function splitThinkingFromSummary(text: string): {
  thinking: string | undefined
  content: string
} {
  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi
  const parts: string[] = []
  const content = text
    .replace(thinkingRegex, (_, inner) => {
      const trimmed = String(inner).trim()
      if (trimmed) parts.push(trimmed)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return {
    thinking: parts.length > 0 ? parts.join('\n\n') : undefined,
    content,
  }
}

/**
 * Generates a short session recap for the "while you were away" card.
 * Returns null on abort, empty transcript, or error.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<{ content: string; thinking: string | undefined } | null> {
  if (messages.length === 0) {
    return null
  }

  try {
    const recent = messages
      .slice(-RECENT_MESSAGE_WINDOW)
      .map(message => shrinkMessage(message))
    const response = await queryModelWithoutStreaming({
      messages: recent,
      systemPrompt: asSystemPrompt([RECAP_SYSTEM_PROMPT]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: getUtilityModel(),
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'away_summary',
        skipCacheWrite: true,
      },
    })

    if (response.isApiErrorMessage) {
      logForDebugging(
        `[awaySummary] API error: ${getAssistantMessageText(response)}`,
      )
      return null
    }
    const raw = getAssistantMessageText(response) ?? ''
    const { thinking, content } = splitThinkingFromSummary(raw)
    if (!content) return null
    return { content, thinking }
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return null
    }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return null
  }
}
