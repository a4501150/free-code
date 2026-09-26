/**
 * requestJwtAuthorizationGrant picks its client-authentication form from the
 * IdP's advertised token_endpoint_auth_methods_supported:
 * - basic advertised → Authorization: Basic header, no secret in the body
 * - only post advertised, or no metadata at all → client_secret in the body
 *   (no-metadata defaults to post because that is what the call has always
 *   sent and what un-advertised IdPs accept)
 */
import { describe, expect, test } from 'bun:test'

import { requestJwtAuthorizationGrant } from '../../src/services/mcp/xaa.js'

function stubExchange() {
  const calls: Array<{
    headers: Record<string, string>
    body: URLSearchParams
  }> = []
  const fetchFn = async (
    _url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      headers: init?.headers as Record<string, string>,
      body: init?.body as URLSearchParams,
    })
    return Response.json({
      access_token: 'id-jag-token',
      issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    })
  }
  return { calls, fetchFn }
}

const baseOpts = {
  tokenEndpoint: 'https://idp.example.com/token',
  audience: 'https://as.example.com',
  resource: 'https://mcp.example.com/mcp',
  idToken: 'id-token',
  clientId: 'idp-client',
  clientSecret: 'idp-secret',
}

describe('requestJwtAuthorizationGrant auth-method selection', () => {
  test('uses client_secret_basic when the IdP advertises it', async () => {
    const { calls, fetchFn } = stubExchange()
    await requestJwtAuthorizationGrant({
      ...baseOpts,
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
      fetchFn,
    })

    expect(calls).toHaveLength(1)
    const { headers, body } = calls[0]
    const expected = Buffer.from('idp-client:idp-secret').toString('base64')
    expect(headers.Authorization).toBe(`Basic ${expected}`)
    expect(body.get('client_secret')).toBeNull()
  })

  test('no advertised methods keeps the historical client_secret_post body form', async () => {
    const { calls, fetchFn } = stubExchange()
    await requestJwtAuthorizationGrant({ ...baseOpts, fetchFn })

    const { headers, body } = calls[0]
    expect(headers.Authorization).toBeUndefined()
    expect(body.get('client_secret')).toBe('idp-secret')
  })

  test('post-only advertisement sends the secret in the body', async () => {
    const { calls, fetchFn } = stubExchange()
    await requestJwtAuthorizationGrant({
      ...baseOpts,
      tokenEndpointAuthMethods: ['client_secret_post'],
      fetchFn,
    })

    const { headers, body } = calls[0]
    expect(headers.Authorization).toBeUndefined()
    expect(body.get('client_secret')).toBe('idp-secret')
  })
})
