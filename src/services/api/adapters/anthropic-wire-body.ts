import {
  domainBlockToAnthropic,
  domainUserBlockToAnthropic,
} from '../../../types/domainConversion.js'
import type {
  DomainMessageParam,
  DomainMessageRequest,
} from '../domain-transport.js'

function domainMessageToWireParam(
  message: DomainMessageParam,
): Record<string, unknown> {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.content.map(domainUserBlockToAnthropic),
    }
  }
  return {
    role: 'assistant',
    content: message.content.flatMap(block => {
      const converted = domainBlockToAnthropic(block)
      if (!converted) return []
      const cacheControl = (block as unknown as { cache_control?: unknown })
        .cache_control
      return [
        {
          ...converted,
          ...(cacheControl !== undefined && { cache_control: cacheControl }),
        },
      ]
    }),
  }
}

export function buildAnthropicWireBody(
  request: DomainMessageRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(domainMessageToWireParam),
    max_tokens: request.maxTokens,
  }

  if (request.system) body.system = request.system
  if (request.tools && request.tools.length > 0) body.tools = request.tools
  if (request.toolChoice) body.tool_choice = request.toolChoice
  if (request.thinking) {
    body.thinking =
      request.thinking.type === 'enabled'
        ? { type: 'enabled', budget_tokens: request.thinking.budgetTokens }
        : request.thinking
  }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.speed) body.speed = request.speed
  if (request.betas) body.betas = request.betas
  if (request.metadata) body.metadata = request.metadata
  if (request.outputConfig) body.output_config = request.outputConfig
  if (request.contextManagement)
    body.context_management = request.contextManagement
  if (request.advisorModel) body.advisor_model = request.advisorModel
  if (request.stopSequences) body.stop_sequences = request.stopSequences

  if (request.extraBody) {
    for (const [key, value] of Object.entries(request.extraBody)) {
      if (!(key in body)) {
        body[key] = value
      }
    }
  }

  return body
}
