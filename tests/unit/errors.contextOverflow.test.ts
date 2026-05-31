import { APIError } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'
import {
  classifyAPIError,
  getAssistantMessageFromError,
  isPromptTooLongMessage,
} from '../../src/services/api/errors.js'
import type { NormalizedApiError } from '../../src/utils/normalizedError.js'

function codedError(kind: NormalizedApiError['kind']): APIError {
  const normalized: NormalizedApiError = {
    kind,
    message: 'Maximum context length exceeded',
    status: 400,
    providerType: 'openai-responses',
    raw: null,
  }
  return new APIError(400, { normalized }, undefined, new Headers())
}

describe('coded context overflow mapping', () => {
  test('maps coded overflow to the prompt-too-long assistant path', () => {
    const error = codedError('context_overflow')
    const message = getAssistantMessageFromError(error, 'openai:test')

    expect(isPromptTooLongMessage(message)).toBe(true)
    expect(message.error).toBe('invalid_request')
    expect(classifyAPIError(error)).toBe('prompt_too_long')
  })

  test('leaves unrelated coded invalid requests generic', () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const error = codedError('invalid_request')
      const message = getAssistantMessageFromError(error, 'openai:test')

      expect(isPromptTooLongMessage(message)).toBe(false)
      expect(classifyAPIError(error)).not.toBe('prompt_too_long')
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })
})
