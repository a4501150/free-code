// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getProviderRegistry } from './providerRegistry.js'
import { sideQuery } from '../sideQuery.js'
import {
  DomainTransportError,
  DomainConnectionError,
} from '../../services/api/domain-errors.js'

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // Check if it matches ANTHROPIC_CUSTOM_MODEL_OPTION (pre-validated by the user)
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // Check if the model exists in the provider registry (covers custom providers)
  const registry = getProviderRegistry()
  if (registry.getProviderForModel(normalizedModel)) {
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  }

  // Check cache first
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }

  // Try to make an actual API call with minimal parameters
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    // If we got here, the model is valid
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
): { valid: boolean; error: string } {
  // A 404 means the model doesn't exist
  if (error instanceof DomainTransportError && error.status === 404) {
    return {
      valid: false,
      error: `Model '${modelName}' not found`,
    }
  }

  if (error instanceof DomainConnectionError) {
    return {
      valid: false,
      error: 'Network error. Please check your internet connection.',
    }
  }

  // For other API errors, provide context-specific messages
  if (error instanceof DomainTransportError) {
    if (error.normalized.kind === 'auth') {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    // Check error body for model-specific errors
    const raw = error.raw as { body?: unknown; error?: unknown } | undefined
    const errorBody = raw?.body ?? raw?.error
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // Generic API error
    return { valid: false, error: `API error: ${error.message}` }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}
