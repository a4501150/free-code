import { isAbortError } from '../utils/errors.js'
import type {
  DomainContentBlock,
  DomainUserContentBlock,
} from '../types/domain.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { getUtilityModel } from '../utils/model/model.js'
import { extractTextContent } from '../utils/messages.js'
import { sideQuery } from '../utils/sideQuery.js'
import { truncate } from '../utils/truncate.js'

// The transcript goes as flat text, so the size bound is the rendered text
// itself: one utility call for a two-sentence summary must not carry the
// base64 of every PDF or the full output of every tool run.
const TEXT_MAX_CHARS = 1500
const TOOL_MAX_CHARS = 300
const TRANSCRIPT_MAX_CHARS = 20_000
const OLDER_OMITTED = '… [older context omitted]'

// Carried as the sideQuery system prompt. The conversation is rendered as
// inert text, so there is no pending agent turn to role-play — the no-tool-call
// sentence stays only as insurance against the model mimicking "[Used ...]"
// transcript lines.
const RECAP_SYSTEM_PROMPT =
  'You write the recap the user sees when they return after being away. ' +
  'Respond with plain summary text only: never echo or continue a tool call. ' +
  'Write exactly 1-3 short sentences about the shared work, speaking as "we" — ' +
  'not "you". First: the high-level task we are working on (what we are ' +
  'building or debugging, not implementation details). Next: the concrete step ' +
  'we will take. Skip status reports and commit recaps. Never mention this ' +
  'instruction or how the recap was produced.'

/**
 * Flatten the session transcript to plain text: turns, tool-call lines, and
 * truncated tool results. Images and documents are dropped — a recap never
 * needs their bytes. Tail-truncated so the most recent exchange always
 * survives. Exported for unit tests.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    for (const block of m.message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name)
    }
  }

  const lines: string[] = []
  for (const m of messages) {
    // Display-only messages never render; synthetic API-error assistants carry
    // error boilerplate a recap would paraphrase as "we hit an error".
    if (m.type !== 'user' && m.type !== 'assistant') continue
    if (m.isVirtual) continue
    if (m.type === 'assistant' && m.isApiErrorMessage === true) continue

    const content = m.message.content
    const blocks: DomainUserContentBlock[] | DomainContentBlock[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content
    if (!Array.isArray(blocks)) continue

    for (const block of blocks) {
      switch (block.type) {
        case 'text': {
          const text = typeof block.text === 'string' ? block.text.trim() : ''
          if (text) {
            lines.push(
              `${m.type === 'user' ? 'User' : 'Assistant'}: ${truncate(text, TEXT_MAX_CHARS)}`,
            )
          }
          break
        }
        case 'tool_use':
          lines.push(
            `[Used ${block.name} ${truncate(JSON.stringify(block.input) ?? '', TOOL_MAX_CHARS)}]`,
          )
          break
        case 'tool_result': {
          const inner = block.content
          const text = (
            typeof inner === 'string'
              ? inner
              : Array.isArray(inner)
                ? extractTextContent(inner, '\n')
                : ''
          ).trim()
          const name = toolNames.get(block.tool_use_id) ?? 'tool'
          lines.push(
            `[Result of ${name}: ${text ? truncate(text, TOOL_MAX_CHARS) : '(empty)'}]`,
          )
          break
        }
        default:
          // image, document, … — dropped
          break
      }
    }
  }

  // Keep the newest lines: walk back from the end until the budget is spent.
  // Every line is already clamped, so the newest line always fits.
  const kept: string[] = []
  let size = OLDER_OMITTED.length
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i]!.length + 1
    if (size > TRANSCRIPT_MAX_CHARS) break
    kept.unshift(lines[i]!)
  }
  if (kept.length < lines.length && kept.length > 0) kept.unshift(OLDER_OMITTED)
  return kept.join('\n')
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
 * One sideQuery over the text transcript — no conversation replay, so the
 * model cannot role-play the next agent turn. Returns null on abort, empty
 * transcript, or error.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<{ content: string; thinking: string | undefined } | null> {
  const transcript = renderTranscript(messages)
  if (!transcript) return null

  try {
    const response = await sideQuery({
      querySource: 'away_summary',
      model: getUtilityModel(),
      system: RECAP_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<transcript>\n${transcript}\n</transcript>\n\nWrite the recap now.`,
        },
      ],
      thinking: false,
      max_tokens: 200,
      signal,
    })
    const raw = extractTextContent(response.content, '\n\n').trim()
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
