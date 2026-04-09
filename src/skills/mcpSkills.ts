/**
 * Discover skills from MCP server resources with a `skill://` URI scheme.
 *
 * Each matching resource is fetched, parsed as markdown with frontmatter,
 * and converted into a Command that the SkillTool can invoke. The function
 * is memoized per-server so repeated connections don't re-fetch.
 *
 * This module is feature-gated behind MCP_SKILLS and conditionally required
 * by src/services/mcp/client.ts and src/services/mcp/useManageMCPConnections.ts.
 */

import {
  type ReadResourceResult,
  ReadResourceResultSchema,
  ListResourcesResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Command } from '../types/command.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logError } from '../utils/log.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

/** Match the cache size used by other mcp fetch functions in client.ts */
const MCP_FETCH_CACHE_SIZE = 20

/**
 * Fetch and register skills discovered from MCP server resources.
 * Resources whose URI starts with `skill://` are treated as skill definitions:
 * markdown content with YAML frontmatter, identical to local SKILL.md files.
 *
 * The result has a `.cache` property (from memoizeWithLRU) so callers can
 * invalidate with `fetchMcpSkillsForClient.cache.delete(serverName)`.
 */
export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      // List all resources and filter for skill:// URIs
      const listResult = await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )

      if (!listResult.resources) return []

      const skillResources = listResult.resources.filter(r =>
        r.uri.startsWith('skill://'),
      )

      if (skillResources.length === 0) return []

      const { createSkillCommand, parseSkillFrontmatterFields } =
        getMCPSkillBuilders()

      const commands: Command[] = []

      for (const resource of skillResources) {
        try {
          // Read the resource content
          const readResult = (await client.client.request(
            {
              method: 'resources/read',
              params: { uri: resource.uri },
            },
            ReadResourceResultSchema,
          )) as ReadResourceResult

          // Extract text content from the first content block
          const textContent = readResult.contents.find(
            (c): c is typeof c & { text: string } => 'text' in c,
          )
          if (!textContent?.text) continue

          // Parse frontmatter and create command
          const { frontmatter, content: markdownContent } = parseFrontmatter(
            textContent.text,
            resource.uri,
          )

          // Derive skill name from the URI path: skill://server/name -> name
          const uriPath = resource.uri.replace(/^skill:\/\//, '')
          const skillName =
            uriPath.split('/').pop() || resource.name || 'unnamed-skill'

          const parsed = parseSkillFrontmatterFields(
            frontmatter,
            markdownContent,
            skillName,
          )

          commands.push(
            createSkillCommand({
              ...parsed,
              skillName,
              markdownContent,
              source: 'mcp',
              baseDir: undefined,
              loadedFrom: 'mcp',
              paths: undefined,
            }),
          )
        } catch (err) {
          // Log per-resource errors but continue processing other resources
          logError(err)
        }
      }

      return commands
    } catch (error) {
      logError(error)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
