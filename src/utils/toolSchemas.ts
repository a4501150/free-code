import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'
import { getProviderRegistry } from './model/providerRegistry.js'
import { jsonStringify } from './slowOperations.js'
import { getToolSchemaCache } from './toolSchemaCache.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

type APIToolInputSchema = any

export type ToolSchema = {
  type?: string | null
  name: string
  description?: string | null
  input_schema: APIToolInputSchema
  cache_control?: {
    type: 'ephemeral'
    scope?: 'global' | 'org'
    ttl?: '5m' | '1h'
  }
}

export type ToolSchemaUnion =
  | ToolSchema
  | { type?: string | null; name: string }

// Extended ToolSchema type with cache-control and streaming support
type ToolSchemaWithExtras = ToolSchema & {
  cache_control?: {
    type: 'ephemeral'
    scope?: 'global' | 'org'
    ttl?: '5m' | '1h'
  }
  eager_input_streaming?: boolean
}

// Fields to filter from tool schemas when swarms are not enabled
const SWARM_FIELDS_BY_TOOL: Record<string, string[]> = {
  [EXIT_PLAN_MODE_TOOL_NAME]: ['launchSwarm', 'teammateCount'],
  [AGENT_TOOL_NAME]: ['name', 'team_name', 'mode'],
}

/**
 * Filter swarm-related fields from a tool's input schema.
 * Called at runtime when isAgentSwarmsEnabled() returns false.
 */
function filterSwarmFieldsFromSchema(
  toolName: string,
  schema: APIToolInputSchema,
): APIToolInputSchema {
  const fieldsToRemove = SWARM_FIELDS_BY_TOOL[toolName]
  if (!fieldsToRemove || fieldsToRemove.length === 0) {
    return schema
  }

  // Clone the schema to avoid mutating the original
  const filtered = { ...schema }
  const props = filtered.properties
  if (props && typeof props === 'object') {
    const filteredProps = { ...(props as Record<string, unknown>) }
    for (const field of fieldsToRemove) {
      delete filteredProps[field]
    }
    filtered.properties = filteredProps
  }

  return filtered
}

export async function toolToAPISchema(
  tool: Tool,
  options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
    cacheControl?: {
      type: 'ephemeral'
      scope?: 'global' | 'org'
      ttl?: '5m' | '1h'
    }
  },
): Promise<ToolSchemaUnion> {
  // Session-stable base schema: name, description, input_schema,
  // eager_input_streaming. Computed once per session and cached to prevent
  // mid-session tool.prompt() drift from churning the serialized tool array
  // bytes. See toolSchemaCache.ts for rationale.
  //
  // Cache key includes inputJSONSchema when present. StructuredOutput instances
  // share the name 'StructuredOutput' but carry different schemas per workflow
  // call — name-only keying returned a stale schema (5.4% → 51% err rate, see
  // PR#25424). MCP tools also set inputJSONSchema but each has a stable schema,
  // so including it preserves their GB-flip cache stability.
  const isToolOwnedSchema = 'inputJSONSchema' in tool && tool.inputJSONSchema
  const modelInputSchema = isToolOwnedSchema
    ? tool.inputJSONSchema!
    : zodToJsonSchema(tool.modelInputSchema ?? tool.inputSchema)
  const cacheKey =
    isToolOwnedSchema || tool.modelInputSchema
      ? `${tool.name}:${jsonStringify(modelInputSchema)}`
      : tool.name
  const cache = getToolSchemaCache()
  let base = cache.get(cacheKey)
  if (!base) {
    // Tool-owned schema (MCP, StructuredOutput) — caller controls the shape.
    // Zod-derived schemas are sent as natural JSON Schema — optional fields
    // stay optional, validation keywords (minimum, maximum, etc.) are preserved.
    let input_schema = modelInputSchema as APIToolInputSchema

    if (!isAgentSwarmsEnabled()) {
      input_schema = filterSwarmFieldsFromSchema(tool.name, input_schema)
    }

    base = {
      name: tool.name,
      description: await tool.prompt({
        getToolPermissionContext: options.getToolPermissionContext,
        tools: options.tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
      }),
      input_schema,
    }

    if (
      (options.model
        ? getProviderRegistry().getCapability(
            options.model,
            'eagerInputStreaming',
          )
        : getProviderRegistry().getCapabilities().eagerInputStreaming) &&
      ((getInitialSettings()?.fineGrainedToolStreaming ?? false) ||
        isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING))
    ) {
      base.eager_input_streaming = true
    }

    cache.set(cacheKey, base)
  }

  const schema: ToolSchemaWithExtras = {
    name: base.name,
    description: base.description,
    input_schema: base.input_schema,
    ...(base.eager_input_streaming && { eager_input_streaming: true }),
  }

  if (options.cacheControl) {
    schema.cache_control = options.cacheControl
  }

  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is the kill switch for beta API
  // shapes. Proxy gateways (ANTHROPIC_BASE_URL → LiteLLM → Bedrock) reject
  // beta fields with "Extra inputs are not permitted". The gates above each
  // field are scattered and not all provider-aware, so this strips everything
  // not in the base-tool allowlist at the one choke point all tool schemas pass
  // through — including fields added in the future.
  // cache_control is allowlisted: the base {type: 'ephemeral'} shape is
  // standard prompt caching (Bedrock/Vertex supported); the beta sub-fields
  // (scope, ttl) are already gated upstream by shouldIncludeFirstPartyOnlyBetas
  // which independently respects this kill switch.
  // github.com/anthropics/claude-code/issues/20031
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    const allowed = new Set([
      'name',
      'description',
      'input_schema',
      'cache_control',
    ])
    const stripped = Object.keys(schema).filter(k => !allowed.has(k))
    if (stripped.length > 0) {
      logStripOnce(stripped)
      return {
        name: schema.name,
        description: schema.description,
        input_schema: schema.input_schema,
        ...(schema.cache_control && { cache_control: schema.cache_control }),
      }
    }
  }

  // Extra fields are still present at runtime and will be serialized
  // in the API request. This is intentional for beta features.
  return schema as ToolSchema
}

let loggedStrip = false
function logStripOnce(stripped: string[]): void {
  if (loggedStrip) return
  loggedStrip = true
  logForDebugging(
    `[betas] Stripped from tool schemas: [${stripped.join(', ')}] (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)`,
  )
}
