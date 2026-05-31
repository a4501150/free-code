import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import {
  countMessagesTokensWithAPI,
  type TokenCountMessageParam,
} from '../services/tokenEstimation.js'
import { getAttributionHeader, getCLISyspromptPrefix } from '../constants/system.js'
import type { ToolPermissionContext, Tools } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { computeFingerprintFromMessages } from '../utils/fingerprint.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'
import { getProviderRegistry } from '../utils/model/providerRegistry.js'
import { toolToAPISchema } from '../utils/api.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'

// -- deps

export async function countPromptTokensForQuery({
  messages,
  systemPrompt,
  tools,
  getToolPermissionContext,
  agents,
  allowedAgentTypes,
  model,
  isNonInteractiveSession,
  hasAppendSystemPrompt,
}: {
  messages: Parameters<typeof normalizeMessagesForAPI>[0]
  systemPrompt: SystemPrompt
  tools: Tools
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  model: string
  isNonInteractiveSession: boolean
  hasAppendSystemPrompt: boolean
}): Promise<number | null> {
  const normalizedMessages = normalizeMessagesForAPI(messages, tools)
  const registry = getProviderRegistry()
  const fingerprint = computeFingerprintFromMessages(normalizedMessages)
  const effectiveSystemPrompt = [
    registry.isAnthropicType(model) ? getAttributionHeader(fingerprint) : '',
    getCLISyspromptPrefix({
      isNonInteractive: isNonInteractiveSession,
      hasAppendSystemPrompt,
    }),
    ...systemPrompt,
  ]
    .filter(Boolean)
    .join('\n\n')
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents,
        allowedAgentTypes,
        model,
      }),
    ),
  )
  const tokenCountMessages = normalizedMessages.map(message => ({
    role: message.message.role,
    content: message.message.content,
  })) as TokenCountMessageParam[]
  return countMessagesTokensWithAPI(tokenCountMessages, toolSchemas, {
    model,
    system: effectiveSystemPrompt,
  })
}

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  countPromptTokens: typeof countPromptTokensForQuery

  // -- platform
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    countPromptTokens: countPromptTokensForQuery,
    uuid: randomUUID,
  }
}
