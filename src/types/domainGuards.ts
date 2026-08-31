/**
 * Type guards for domain content blocks.
 *
 * These replace the ad-hoc `block.type === 'thinking'` checks scattered
 * through the codebase. Use these for consistent, type-narrowing checks
 * on domain content blocks.
 */

import type {
  DomainContentBlock,
  DomainReasoningBlock,
  DomainRedactedReasoningBlock,
  DomainTextBlock,
  DomainToolUseBlock,
} from './domain.js'

export function isReasoningBlock(
  block: DomainContentBlock | { type: string; [key: string]: unknown },
): block is DomainReasoningBlock {
  return block.type === 'reasoning'
}

export function isRedactedReasoningBlock(
  block: DomainContentBlock | { type: string; [key: string]: unknown },
): block is DomainRedactedReasoningBlock {
  return block.type === 'redacted_reasoning'
}

export function isAnyReasoningBlock(
  block: DomainContentBlock | { type: string; [key: string]: unknown },
): block is DomainReasoningBlock | DomainRedactedReasoningBlock {
  return block.type === 'reasoning' || block.type === 'redacted_reasoning'
}

export function isTextBlock(
  block: DomainContentBlock | { type: string; [key: string]: unknown },
): block is DomainTextBlock {
  return block.type === 'text'
}

export function isToolUseBlock(
  block: DomainContentBlock | { type: string; [key: string]: unknown },
): block is DomainToolUseBlock {
  return block.type === 'tool_use'
}

export function hasOpaqueReasoning(block: DomainReasoningBlock): boolean {
  if (block.text) return false
  return !!block.providerState?.bedrockConverse?.redactedContent
}
