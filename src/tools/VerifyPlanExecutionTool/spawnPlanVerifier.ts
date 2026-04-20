import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { query } from '../../query.js'
import { type Tool, type ToolUseContext, toolMatchesName } from '../../Tool.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  createSyntheticOutputTool,
} from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../constants/tools.js'
import { asAgentId } from '../../types/ids.js'
import { createAbortController } from '../../utils/abortController.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import {
  createUserMessage,
  handleMessageFromStream,
} from '../../utils/messages.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { registerStructuredOutputEnforcement } from '../../utils/hooks/hookHelpers.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { VERIFICATION_SYSTEM_PROMPT } from '../AgentTool/built-in/verificationAgent.js'

/**
 * Structured verdict returned by the plan verifier subagent.
 */
const verdictSchema = z.object({
  verified: z.boolean(),
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']),
  message: z.string(),
})

export type PlanVerifierResult = z.infer<typeof verdictSchema>

const verdictJsonSchema = {
  type: 'object',
  properties: {
    verified: {
      type: 'boolean',
      description:
        'True iff the plan was fully implemented and no adversarial probes surfaced blocking issues.',
    },
    verdict: {
      type: 'string',
      enum: ['PASS', 'FAIL', 'PARTIAL'],
      description:
        'PASS / FAIL / PARTIAL. PARTIAL is reserved for environmental limitations (missing test framework, tool unavailable, server can not start).',
    },
    message: {
      type: 'string',
      description:
        'Full verifier report (check blocks + summary) shown to the main model.',
    },
  },
  required: ['verified', 'verdict', 'message'],
  additionalProperties: false,
} as const

const TIMEOUT_MS = 5 * 60 * 1000

/**
 * Spawn a subagent that adversarially verifies the approved plan was
 * implemented in the current working directory. Shares tools with the parent
 * (minus the disallowed-agent set) and runs inside a 5 minute wall-clock
 * sandbox — no turn-count cap, since cutting a verifier mid-thought at
 * some arbitrary turn is worse than letting it take the full timeout.
 *
 * Inlines the primitives used by execAgentHook (structured output tool +
 * enforcement hook + transcript read-rule) without constructing an AgentHook
 * object — the intermediate indirection was removed in the refactor at
 * src/schemas/hooks.ts:128-137.
 */
export async function spawnPlanVerifier(
  plan: string,
  toolUseContext: ToolUseContext,
  parentSignal: AbortSignal,
): Promise<PlanVerifierResult> {
  const structuredToolResult = createSyntheticOutputTool(
    verdictJsonSchema as unknown as Record<string, unknown>,
  )
  if ('error' in structuredToolResult) {
    return {
      verified: false,
      verdict: 'PARTIAL',
      message: `Failed to build verifier structured-output schema: ${structuredToolResult.error}`,
    }
  }
  const structuredOutputTool = structuredToolResult.tool

  const transcriptPath = getTranscriptPath()

  // Tools for the child: parent's set minus disallowed-agent tools, minus any
  // pre-existing StructuredOutput (to avoid schema collisions), plus our
  // verifier's structured-output tool.
  const tools: Tool[] = [
    ...toolUseContext.options.tools.filter(
      t =>
        !ALL_AGENT_DISALLOWED_TOOLS.has(t.name) &&
        !toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    ),
    structuredOutputTool,
  ]

  const systemPrompt = asSystemPrompt([
    `The plan you are verifying against:\n\n${plan}\n\n${VERIFICATION_SYSTEM_PROMPT}`,
  ])

  const childAbort = createAbortController()
  const { signal: timeoutSignal, cleanup: cleanupCombinedSignal } =
    createCombinedAbortSignal(parentSignal, { timeoutMs: TIMEOUT_MS })
  const onTimeoutOrParent = () => childAbort.abort()
  timeoutSignal.addEventListener('abort', onTimeoutOrParent)

  const childAgentId = asAgentId(`plan-verify-${randomUUID()}`)

  const childContext: ToolUseContext = {
    ...toolUseContext,
    agentId: childAgentId,
    abortController: childAbort,
    options: {
      ...toolUseContext.options,
      tools,
      isNonInteractiveSession: true,
      thinkingConfig: { type: 'disabled' as const },
    },
    setInProgressToolUseIDs: () => {},
    getAppState() {
      const appState = toolUseContext.getAppState()
      const existingSessionRules =
        appState.toolPermissionContext.alwaysAllowRules.session ?? []
      return {
        ...appState,
        toolPermissionContext: {
          ...appState.toolPermissionContext,
          mode: 'dontAsk' as const,
          alwaysAllowRules: {
            ...appState.toolPermissionContext.alwaysAllowRules,
            session: [...existingSessionRules, `Read(/${transcriptPath})`],
          },
        },
      }
    },
  }

  registerStructuredOutputEnforcement(toolUseContext.setAppState, childAgentId)

  const initialMessage = createUserMessage({
    content: `Verify that the approved plan (see system prompt) has been fully implemented in the current working directory. Produce a report following the required check-block format and end with the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool.`,
  })

  let result: PlanVerifierResult | null = null

  try {
    for await (const message of query({
      messages: [initialMessage],
      systemPrompt,
      userContext: {},
      systemContext: {},
      canUseTool: hasPermissionsToUseTool,
      toolUseContext: childContext,
      querySource: 'verification_agent',
    })) {
      handleMessageFromStream(
        message,
        () => {},
        newContent =>
          toolUseContext.setResponseLength(
            length => length + newContent.length,
          ),
        toolUseContext.setStreamMode ?? (() => {}),
        () => {},
      )

      if (
        message.type === 'stream_event' ||
        message.type === 'stream_request_start'
      ) {
        continue
      }

      if (
        message.type === 'attachment' &&
        message.attachment.type === 'structured_output'
      ) {
        const parsed = verdictSchema.safeParse(message.attachment.data)
        if (parsed.success) {
          result = parsed.data
          childAbort.abort()
          break
        }
      }
    }
  } finally {
    timeoutSignal.removeEventListener('abort', onTimeoutOrParent)
    cleanupCombinedSignal()
    clearSessionHooks(toolUseContext.setAppState, childAgentId)
  }

  if (!result) {
    return {
      verified: false,
      verdict: 'PARTIAL',
      message:
        'Verifier did not produce a structured verdict within the turn/time budget.',
    }
  }
  return result
}
