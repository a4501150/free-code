import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
  resolveParentAgentId,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { toAgentId } from '../../types/ids.js'
import { errorMessage } from '../../utils/errors.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { deliverToSession } from '../../utils/sessionMessaging.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = z.object({
  to: z
    .string()
    .describe(
      'Recipient: agent name or ID of a subagent you spawned, "parent" for the agent that spawned you (from a depth-1 agent that is the main session), or "session:<id>" for another live session.',
    ),
  message: z.string(),
})
type InputSchema = typeof inputSchema

export type Input = z.infer<InputSchema>

export type MessageOutput = {
  success: boolean
  message: string
}

export type SendMessageToolOutput = MessageOutput

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    maxResultSizeChars: 100_000,
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
    }),

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema
    },

    isEnabled() {
      // Available in every mode: any session can spawn background agents,
      // and subagents address their parent via to: 'parent'. Coordinator
      // mode additionally instructs continuation by agent ID in its prompt.
      return true
    },

    isReadOnly() {
      return true
    },

    toAutoClassifierInput(input) {
      return `to ${input.to}: ${input.message}`
    },

    async checkPermissions(input, _context) {
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, _context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    async call(input, context, canUseTool, assistantMessage) {
      // Session addressing: to:"session:<id>" delivers the message as a
      // prompt turn to another live session, over that process's attach
      // channel. Live peers are discoverable with ListAgents.
      if (input.to.startsWith('session:')) {
        const sessionId = input.to.slice('session:'.length)
        const delivered = await deliverToSession(sessionId, input.message)
        return {
          data: delivered.ok
            ? {
                success: true,
                message: `Message delivered to session ${sessionId} as a prompt turn.`,
              }
            : {
                success: false,
                message: delivered.error ?? 'delivery failed',
              },
        }
      }
      const appState = context.getAppState()

      // Shared in-process recipient routing: a running agent gets the
      // message queued for its next tool round; a stopped or evicted agent
      // is auto-resumed from its transcript with the message as prompt.
      // Re-reads the task store per call — an await (parent resolution,
      // resume) may have changed it since the caller's snapshot.
      const routeToAgent = async (
        agentId: string,
        label: string,
      ): Promise<{ data: MessageOutput }> => {
        const task = context.getAppState().tasks[agentId]
        if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
          if (task.status === 'running') {
            queuePendingMessage(
              agentId,
              input.message,
              context.setAppStateForTasks ?? context.setAppState,
            )
            return {
              data: {
                success: true,
                message: `Message queued for delivery to ${label} at its next tool round.`,
              },
            }
          }
          // task exists but stopped — auto-resume
          try {
            const result = await resumeAgentBackground({
              agentId,
              prompt: input.message,
              toolUseContext: context,
              canUseTool,
              invokingRequestId: assistantMessage?.requestId,
            })
            return {
              data: {
                success: true,
                message: `Agent "${label}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Agent "${label}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
              },
            }
          }
        } else {
          // task evicted from state — try resume from disk transcript.
          // agentId is either a registered name or a format-matching raw ID
          // (toAgentId validates the createAgentId format, so unknown names
          // never reach this block).
          try {
            const result = await resumeAgentBackground({
              agentId,
              prompt: input.message,
              toolUseContext: context,
              canUseTool,
              invokingRequestId: assistantMessage?.requestId,
            })
            return {
              data: {
                success: true,
                message: `Agent "${label}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Agent "${label}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
              },
            }
          }
        }
      }

      // Parent addressing: the agent that spawned the caller. From a
      // depth-1 agent the parent is the main session — not routable by
      // name/ID (the isMainSessionTask guard below), so deliver on the
      // main thread's notification lane instead: mode 'task-notification'
      // with agentId undefined is drained at the main session's next tool
      // round, rendered with the agent-message origin.
      if (input.to === 'parent') {
        const senderAgentId = context.agentId
        if (!senderAgentId) {
          return {
            data: {
              success: false,
              message:
                '"parent" addressing is only available from a subagent. Use ListAgents to find other recipients.',
            },
          }
        }
        const parentAgentId = await resolveParentAgentId(
          senderAgentId,
          appState.tasks,
        )
        if (parentAgentId === undefined) {
          enqueuePendingNotification({
            value: input.message,
            mode: 'task-notification',
            priority: 'next',
            origin: { kind: 'agent-message', from: senderAgentId },
          })
          return {
            data: {
              success: true,
              message:
                'Message delivered to the main session; it arrives at the next tool round.',
            },
          }
        }
        return routeToAgent(parentAgentId, parentAgentId)
      }

      // Route to in-process subagent by name or raw agentId. Stopped agents
      // are auto-resumed.
      const registered = appState.agentNameRegistry.get(input.to)
      const agentId = registered ?? toAgentId(input.to)
      if (agentId) {
        return routeToAgent(agentId, input.to)
      }

      return {
        data: {
          success: false,
          message: `Unknown recipient "${input.to}". Use an agent name/ID from ListAgents, "parent" for your spawning agent, or "session:<id>" for a live session.`,
        },
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
