import type { Anthropic } from '@anthropic-ai/sdk'
// @aws-sdk/client-bedrock-runtime is imported dynamically in countTokensWithBedrock()
// to defer ~279KB of AWS SDK code until a Bedrock call is actually made
import {
  CountTokensCommand,
  type CountTokensCommandInput,
} from '@aws-sdk/client-bedrock-runtime'
import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utils/model/bedrock.js'
import {
  getMainLoopModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getAnthropicClient } from './api/client.js'
import { withTokenCountVCR } from './vcr.js'

// Minimal values for token counting with thinking enabled
// API constraint: max_tokens must be greater than thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * Check if messages contain thinking blocks
 */
function hasThinkingBlocks(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // Special case for empty content - API doesn't accept empty messages
  if (!content) {
    return 0
  }

  const message: Anthropic.Beta.Messages.BetaMessageParam = {
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
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const model = getMainLoopModel()
      const { getAdapterForModel } = await import('./api/adapters/index.js')
      const adapter = getAdapterForModel(model)
      const betas = getModelBetas(model)
      const breakdown = await adapter.countTokens(messages, tools, model, {
        betas,
      })
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
  })
}

/**
 * Shared helper: count tokens against the Anthropic-shape `/count_tokens`
 * endpoint via the Anthropic SDK client. Used by adapters for providers
 * whose wire format is Anthropic-compatible (Anthropic native, Vertex
 * Anthropic, Foundry). The filtered-betas behavior for Vertex is passed
 * in explicitly.
 */
export async function countTokensViaAnthropicEndpoint({
  messages,
  tools,
  model,
  betas,
  filterBetas,
}: {
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  model: string
  betas: string[]
  filterBetas?: (beta: string) => boolean
}): Promise<number | null> {
  const containsThinking = hasThinkingBlocks(messages)
  const anthropic = await getAnthropicClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })
  const filteredBetas = filterBetas ? betas.filter(filterBetas) : betas
  const response = await anthropic.beta.messages.countTokens({
    model: normalizeModelStringForAPI(model),
    messages:
      messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
    tools,
    ...(filteredBetas.length > 0 && { betas: filteredBetas }),
    ...(containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  })
  if (typeof response.input_tokens !== 'number') {
    // Vertex client throws
    // Bedrock client succeeds with { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }
    return null
  }
  return response.input_tokens
}

/**
 * Shared Bedrock CountTokensCommand wrapper. Exposed so the Bedrock adapter
 * can delegate.
 */
export async function countTokensViaBedrock(args: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  return countTokensWithBedrock(args)
}

/** Re-export for adapter consumers — they need to detect thinking blocks for native count params. */
export { hasThinkingBlocks }

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
export function bytesPerTokenForFileType(fileExtension: string): number {
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

export function roughTokenCountEstimationForMessage(message: {
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
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
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
    | Array<Anthropic.ContentBlock>
    | Array<Anthropic.ContentBlockParam>
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
  block: string | Anthropic.ContentBlock | Anthropic.ContentBlockParam,
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
        | import('@anthropic-ai/sdk/resources/messages.mjs').ContentBlockParam[]
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

async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
}: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    // Bedrock CountTokens requires a model ID, not an inference profile / ARN
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      // When we pass tools and no messages, we need to pass a dummy message
      // to get an accurate tool token count.
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    const tokenCount = response.inputTokens ?? null
    return tokenCount
  } catch (error) {
    logError(error)
    return null
  }
}
