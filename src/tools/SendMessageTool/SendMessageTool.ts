import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { toAgentId } from '../../types/ids.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorModeGate.js'
import { errorMessage } from '../../utils/errors.js'
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
      'Recipient: agent name or ID of a subagent you spawned, or "session:<id>" for another live session.',
    ),
  message: z.string().describe('Plain text message content'),
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

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema
    },

    isEnabled() {
      // Coordinator mode must see SendMessage: the coordinator system prompt
      // instructs it to continue workers by agent ID unconditionally.
      return isCoordinatorMode()
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
      // Route to in-process subagent by name or raw agentId. Stopped agents
      // are auto-resumed.
      const appState = context.getAppState()
      const registered = appState.agentNameRegistry.get(input.to)
      const agentId = registered ?? toAgentId(input.to)
      if (agentId) {
        const task = appState.tasks[agentId]
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
                message: `Message queued for delivery to ${input.to} at its next tool round.`,
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
                message: `Agent "${input.to}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Agent "${input.to}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
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
                message: `Agent "${input.to}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Agent "${input.to}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
              },
            }
          }
        }
      }

      return {
        data: {
          success: false,
          message: `Unknown recipient "${input.to}". Use an agent name/ID from ListAgents, or "session:<id>" for a live session.`,
        },
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
