/**
 * Shared API constants.
 *
 * Centralizes the Anthropic Messages API version string and header names
 * shared by the Anthropic-family adapters and the MCP client.
 */

/** Anthropic Messages API version used across all non-SDK HTTP requests. */
export const ANTHROPIC_API_VERSION = '2023-06-01'

/** Header name for client-generated request IDs used by the Anthropic adapter. */
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
