import type {
  DomainContentBlock,
  DomainUserContentBlock,
} from '../types/domain.js'
import type {
  TokenCountMessageParam,
  TokenCountToolParam,
} from './api/adapter.js'

export type { TokenCountMessageParam }

import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getAdapterForModel } from './api/adapters/index.js'
import { withTokenCountVCR } from './vcr.js'

export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // Special case for empty content - API doesn't accept empty messages
  if (!content) {
    return 0
  }

  const message: TokenCountMessageParam = {
    role: 'user',
    content: content,
  }

  return countMessagesTokensWithAPI([message], [])
}

/**
 * Per-provider token counting, routed through the adapter registry.
 *
 * Prior to Step 2 of the provider-agnostic plan, this function branched on
 * `tokenCountingMethod` inline. Now every provider type has a
 * {@link ProviderAdapter.countTokens} implementation in
 * `src/services/api/adapters/`, and the lookup goes through
 * `getAdapterForModel(model)`.
 *
 * Returns `null` on any failure so callers can fall back to rough
 * estimation via {@link roughTokenCountEstimationForMessages}.
 */
export async function countMessagesTokensWithAPI(
  messages: TokenCountMessageParam[],
  tools: TokenCountToolParam[],
  options?: {
    model?: string
    system?: string
  },
): Promise<number | null> {
  return withTokenCountVCR(
    messages,
    tools,
    async () => {
      try {
        const model = options?.model ?? getMainLoopModel()
        const adapter = getAdapterForModel(model)
        const betas = getModelBetas(model)
        const breakdown = await adapter.countTokens(
          messages,
          tools,
          model,
          {
            betas,
            system: options?.system,
          },
        )
        if (!breakdown) return null
        return (
          breakdown.inputTokens +
          (breakdown.cacheReadTokens ?? 0) +
          (breakdown.cacheWriteTokens ?? 0)
        )
      } catch (error) {
        logError(error)
        return null
      }
    },
    options,
  )
}

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Like {@link roughTokenCountEstimation} but uses a more accurate
 * bytes-per-token ratio when the file type is known.
 *
 * This matters when the API-based token count is unavailable (e.g. on
 * Bedrock) and we fall back to the rough estimate — an underestimate can
 * let an oversized tool result slip into the conversation.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

function roughTokenCountEstimationForMessage(message: {
  type: string
  subtype?: string
  message?: { content?: unknown }
  attachment?: Attachment
  content?: unknown
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<DomainContentBlock>
        | Array<DomainUserContentBlock>
        | Array<DomainUserContentBlock>
        | Array<DomainContentBlock>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  // Local-command messages carry their injected content on `content` (a
  // string rendered into the transcript for the model's next turn). Without
  // this branch the `/context` category view reports 0 tokens for every
  // `<local-command-stdout>` payload, which misrepresents context fill
  // especially after running custom slash commands whose output is large.
  if (
    message.type === 'system' &&
    message.subtype === 'local_command' &&
    typeof message.content === 'string'
  ) {
    return roughTokenCountEstimation(message.content)
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<DomainContentBlock>
    | Array<DomainUserContentBlock>
    | Array<DomainUserContentBlock>
    | Array<DomainContentBlock>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block:
    | string
    | DomainContentBlock
    | DomainUserContentBlock
    | DomainUserContentBlock
    | DomainContentBlock
    | { type: string; [key: string]: any },
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image' || block.type === 'document') {
    // https://platform.claude.com/docs/en/build-with-claude/vision#calculate-image-costs
    // tokens = (width px * height px)/750
    // Images are resized to max 2000x2000 (5333 tokens). Use a conservative
    // estimate that matches microCompact's IMAGE_MAX_TOKEN_SIZE to avoid
    // underestimating and triggering auto-compact too late.
    //
    // document: base64 PDF in source.data.  Must NOT reach the
    // jsonStringify catch-all — a 1MB PDF is ~1.33M base64 chars →
    // ~325k estimated tokens, vs the ~2000 the API actually charges.
    // Same constant as microCompact's calculateToolResultTokens.
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(
      block.content as
        | string
        | DomainUserContentBlock[]
        | DomainUserContentBlock[]
        | undefined,
    )
  }
  if (block.type === 'tool_use') {
    // input is the JSON the model generated — arbitrarily large (bash
    // commands, Edit diffs, file contents).  Stringify once for the
    // char count; the API re-serializes anyway so this is what it sees.
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'reasoning') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'redacted_reasoning') {
    return roughTokenCountEstimation(
      block.providerState?.anthropic?.redactedData ?? '',
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use, web_search_tool_result, mcp_tool_use, etc. —
  // text-like payloads (tool inputs, search results, no base64).
  // Stringify-length tracks the serialized form the API sees; the
  // key/bracket overhead is single-digit percent on real blocks.
  return roughTokenCountEstimation(jsonStringify(block))
}
