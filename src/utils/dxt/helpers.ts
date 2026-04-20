import * as mcpbMod from '@anthropic-ai/mcpb'
import type { McpbManifestAny as McpbManifest } from '@anthropic-ai/mcpb'
import { errorMessage } from '../errors.js'
import { jsonParse } from '../slowOperations.js'

/**
 * Parses and validates a DXT manifest from a JSON object.
 */
export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifest> {
  // McpbManifestSchema is accessed through the vAny re-export which wraps schemas/any.js
  const McpbManifestSchema = (mcpbMod as unknown as { vAny?: { McpbManifestSchema?: unknown } }).vAny?.McpbManifestSchema as { safeParse: (v: unknown) => { success: boolean; data: McpbManifest; error: { flatten: () => { fieldErrors: Record<string, unknown[]>; formErrors: string[] } } } } | undefined
  if (!McpbManifestSchema) {
    throw new Error('McpbManifestSchema not found in @anthropic-ai/mcpb')
  }
  const parseResult = McpbManifestSchema.safeParse(manifestJson)

  if (!parseResult.success) {
    const errors = parseResult.error.flatten()
    const errorMessages = [
      ...Object.entries(errors.fieldErrors).map(
        ([field, errs]) => `${field}: ${(errs as string[] | undefined)?.join(', ')}`,
      ),
      ...(errors.formErrors || []),
    ]
      .filter(Boolean)
      .join('; ')

    throw new Error(`Invalid manifest: ${errorMessages}`)
  }

  return parseResult.data
}

/**
 * Parses and validates a DXT manifest from raw text data.
 */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifest> {
  let manifestJson: unknown

  try {
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`Invalid JSON in manifest.json: ${errorMessage(error)}`)
  }

  return validateManifest(manifestJson)
}

/**
 * Parses and validates a DXT manifest from raw binary data.
 */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifest> {
  const manifestText = new TextDecoder().decode(manifestData)
  return parseAndValidateManifestFromText(manifestText)
}

/**
 * Generates an extension ID from author name and extension name.
 * Uses the same algorithm as the directory backend for consistency.
 */
export function generateExtensionId(
  manifest: McpbManifest,
  prefix?: 'local.unpacked' | 'local.dxt',
): string {
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

  const authorName = manifest.author.name
  const extensionName = manifest.name

  const sanitizedAuthor = sanitize(authorName)
  const sanitizedName = sanitize(extensionName)

  return prefix
    ? `${prefix}.${sanitizedAuthor}.${sanitizedName}`
    : `${sanitizedAuthor}.${sanitizedName}`
}
