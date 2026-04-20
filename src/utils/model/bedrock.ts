import {
  BedrockClient,
  GetInferenceProfileCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { NoAuthSigner } from '@smithy/core'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import memoize from 'lodash-es/memoize.js'
import { refreshAndGetAwsCredentials } from '../auth.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { getAWSClientProxyConfig } from '../proxy.js'

// Region-prefix helpers were moved to ./bedrockInferenceProfiles.js so the
// provider registry (which participates in a runtime cycle with auth.ts via
// this file) can import them without pulling in the AWS SDK. Re-export them
// here for the handful of callers (e.g. services/tokenEstimation.ts) that
// still import everything Bedrock-related from this module.
export {
  applyBedrockRegionPrefix,
  BEDROCK_REGION_PREFIXES,
  extractModelIdFromArn,
  getBedrockRegionPrefix,
  isFoundationModel,
} from './bedrockInferenceProfiles.js'
export type { BedrockRegionPrefix } from './bedrockInferenceProfiles.js'

export const getBedrockInferenceProfiles = memoize(async function (): Promise<
  string[]
> {
  const client = await createBedrockClient()
  const allProfiles = []
  let nextToken: string | undefined

  try {
    do {
      const command = new ListInferenceProfilesCommand({
        ...(nextToken && { nextToken }),
        typeEquals: 'SYSTEM_DEFINED',
      })
      const response = await client.send(command)

      if (response.inferenceProfileSummaries) {
        allProfiles.push(...response.inferenceProfileSummaries)
      }

      nextToken = response.nextToken
    } while (nextToken)

    // Filter for Anthropic models (SYSTEM_DEFINED filtering handled in query)
    return allProfiles
      .filter(profile => profile.inferenceProfileId?.includes('anthropic'))
      .map(profile => profile.inferenceProfileId)
      .filter(Boolean) as string[]
  } catch (error) {
    logError(error as Error)
    throw error
  }
})

export function findFirstMatch(
  profiles: string[],
  substring: string,
): string | null {
  return profiles.find(p => p.includes(substring)) ?? null
}

async function createBedrockClient() {
  // Match the Anthropic Bedrock SDK's region behavior exactly:
  // - Reads AWS_REGION or AWS_DEFAULT_REGION env vars (not AWS config files)
  // - Falls back to 'us-east-1' if neither is set
  // This ensures we query profiles from the same region the client will use
  const region = getAWSRegion()

  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      requestHandler: new NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new NoAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // Only refresh credentials if not using API key authentication
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockClient(clientConfig)
}

export async function createBedrockRuntimeClient() {
  const region = getAWSRegion()
  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      // BedrockRuntimeClient defaults to HTTP/2 without fallback
      // proxy servers may not support this, so we explicitly force HTTP/1.1
      requestHandler: new NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new NoAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // Only refresh credentials if not using API key authentication
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockRuntimeClient(clientConfig)
}

export const getInferenceProfileBackingModel = memoize(async function (
  profileId: string,
): Promise<string | null> {
  try {
    const client = await createBedrockClient()
    const command = new GetInferenceProfileCommand({
      inferenceProfileIdentifier: profileId,
    })
    const response = await client.send(command)

    if (!response.models || response.models.length === 0) {
      return null
    }

    // Use the first model as the primary backing model for cost calculation
    // In practice, application inference profiles typically load balance between
    // similar models with the same cost structure
    const primaryModel = response.models[0]
    if (!primaryModel?.modelArn) {
      return null
    }

    // Extract model name from ARN
    // ARN format: arn:aws:bedrock:region:account:foundation-model/model-name
    const lastSlashIndex = primaryModel.modelArn.lastIndexOf('/')
    return lastSlashIndex >= 0
      ? primaryModel.modelArn.substring(lastSlashIndex + 1)
      : primaryModel.modelArn
  } catch (error) {
    logError(error as Error)
    return null
  }
})
