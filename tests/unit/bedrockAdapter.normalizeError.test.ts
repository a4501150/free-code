/**
 * Unit test: bedrock adapter normalizeError.
 */
import { describe, test, expect } from 'bun:test'
import { bedrockAdapter } from '../../src/services/api/adapters/bedrock-adapter-impl.js'

describe('bedrockAdapter.normalizeError', () => {
  test('ThrottlingException EventStream frame → rate_limit', () => {
    const e = bedrockAdapter.normalizeError(
      {
        exceptionType: 'ThrottlingException',
        body: 'Too many requests',
      },
      'bedrock-converse',
    )
    expect(e.kind).toBe('rate_limit')
  })

  test('ServiceUnavailableException frame → overloaded', () => {
    const e = bedrockAdapter.normalizeError(
      { exceptionType: 'ServiceUnavailableException' },
      'bedrock-converse',
    )
    expect(e.kind).toBe('overloaded')
  })

  test('ModelStreamErrorException frame → server', () => {
    const e = bedrockAdapter.normalizeError(
      { exceptionType: 'ModelStreamErrorException' },
      'bedrock-converse',
    )
    expect(e.kind).toBe('server')
  })

  test('AccessDeniedException frame → auth', () => {
    const e = bedrockAdapter.normalizeError(
      { exceptionType: 'AccessDeniedException' },
      'bedrock-converse',
    )
    expect(e.kind).toBe('auth')
  })

  test('HTTP 429 → rate_limit', () => {
    const e = bedrockAdapter.normalizeError(
      { status: 429, body: JSON.stringify({ message: 'throttled' }) },
      'bedrock-converse',
    )
    expect(e.kind).toBe('rate_limit')
    expect(e.message).toBe('throttled')
  })
})
