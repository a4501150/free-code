import * as React from 'react'
import { Box, Text } from '../ink.js'
import type { ContextData } from '../utils/analyzeContext.js'
import { generateContextSuggestions } from '../utils/contextSuggestions.js'
import { getDisplayPath } from '../utils/file.js'
import { formatTokens } from '../utils/format.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from '../utils/settings/constants.js'
import { plural } from '../utils/stringUtils.js'
import { ContextSuggestions } from './ContextSuggestions.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'

// Order for displaying source groups: Project > User > Managed > Plugin > Built-in
const SOURCE_DISPLAY_ORDER = [
  'Project',
  'User',
  'Managed',
  'Plugin',
  'Built-in',
]

/** Group items by source type for display, sorted by tokens descending within each group */
function groupBySource<
  T extends { source: SettingSource | 'plugin' | 'built-in'; tokens: number },
>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = getSourceDisplayName(item.source)
    const existing = groups.get(key) || []
    existing.push(item)
    groups.set(key, existing)
  }
  // Sort each group by tokens descending
  for (const [key, group] of groups.entries()) {
    groups.set(
      key,
      group.sort((a, b) => b.tokens - a.tokens),
    )
  }
  // Return groups in consistent order
  const orderedGroups = new Map<string, T[]>()
  for (const source of SOURCE_DISPLAY_ORDER) {
    const group = groups.get(source)
    if (group) {
      orderedGroups.set(source, group)
    }
  }
  return orderedGroups
}

/**
 * Group MCP tools by server name. Tools within each group stay in their
 * original order (alphabetical from the tool registry). Servers are ordered
 * by total token usage, descending.
 */
function groupByServer<T extends { serverName: string; tokens: number }>(
  items: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const existing = groups.get(item.serverName) || []
    existing.push(item)
    groups.set(item.serverName, existing)
  }
  const sorted = Array.from(groups.entries()).sort(
    (a, b) =>
      b[1].reduce((s, t) => s + t.tokens, 0) -
      a[1].reduce((s, t) => s + t.tokens, 0),
  )
  return new Map(sorted)
}

/**
 * Strip the `mcp__<server>__` prefix from a tool name. The server-prefixed
 * form (`mcp__<server>`) is shown in the group header so users can copy it
 * for permission config; listing the full prefix on every tool would be
 * redundant.
 */
function stripToolPrefix(toolName: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName
}

interface Props {
  data: ContextData
}

export function ContextVisualization({ data }: Props): React.ReactNode {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    gridRows,
    model,
    memoryFiles,
    mcpTools,
    deferredBuiltinTools = [],
    systemTools,
    systemPromptSections,
    agents,
    skills,
    messageBreakdown,
  } = data

  // Filter out categories with 0 tokens for the legend, and exclude Free space, Autocompact buffer, and deferred
  const visibleCategories = categories.filter(
    cat =>
      cat.tokens > 0 &&
      cat.name !== 'Free space' &&
      cat.name !== RESERVED_CATEGORY_NAME &&
      !cat.isDeferred,
  )
  // Check if MCP tools are deferred (loaded on-demand via tool search)
  const hasDeferredMcpTools = categories.some(
    cat => cat.isDeferred && cat.name.includes('MCP'),
  )
  // Check if builtin tools are deferred
  const hasDeferredBuiltinTools = deferredBuiltinTools.length > 0
  const autocompactCategory = categories.find(
    cat => cat.name === RESERVED_CATEGORY_NAME,
  )

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Context Usage</Text>
      <Box flexDirection="row" gap={2}>
        {/* Fixed size grid */}
        <Box flexDirection="column" flexShrink={0}>
          {gridRows.map((row, rowIndex) => (
            <Box key={rowIndex} flexDirection="row" marginLeft={-1}>
              {row.map((square, colIndex) => {
                if (square.categoryName === 'Free space') {
                  return (
                    <Text key={colIndex} dimColor>
                      {'⛶ '}
                    </Text>
                  )
                }
                if (square.categoryName === RESERVED_CATEGORY_NAME) {
                  return (
                    <Text key={colIndex} color={square.color}>
                      {'⛝ '}
                    </Text>
                  )
                }
                return (
                  <Text key={colIndex} color={square.color}>
                    {square.squareFullness >= 0.7 ? '⛁ ' : '⛀ '}
                  </Text>
                )
              })}
            </Box>
          ))}
        </Box>

        {/* Legend to the right */}
        <Box flexDirection="column" gap={0} flexShrink={0}>
          <Text dimColor>
            {model} · {formatTokens(totalTokens)}/{formatTokens(rawMaxTokens)}{' '}
            tokens ({percentage}%)
          </Text>
          <Text> </Text>
          <Text dimColor italic>
            Estimated usage by category
          </Text>
          {visibleCategories.map((cat, index) => {
            const tokenDisplay = formatTokens(cat.tokens)
            // Show "N/A" for deferred categories since they don't count toward context
            const percentDisplay = cat.isDeferred
              ? 'N/A'
              : `${((cat.tokens / rawMaxTokens) * 100).toFixed(1)}%`
            const isReserved = cat.name === RESERVED_CATEGORY_NAME
            const displayName = cat.name
            // Deferred categories don't appear in grid, so show blank instead of symbol
            const symbol = cat.isDeferred ? ' ' : isReserved ? '⛝' : '⛁'

            return (
              <Box key={index}>
                <Text color={cat.color}>{symbol}</Text>
                <Text> {displayName}: </Text>
                <Text dimColor>
                  {tokenDisplay} tokens ({percentDisplay})
                </Text>
              </Box>
            )
          })}
          {(categories.find(c => c.name === 'Free space')?.tokens ?? 0) > 0 && (
            <Box>
              <Text dimColor>⛶</Text>
              <Text> Free space: </Text>
              <Text dimColor>
                {formatTokens(
                  categories.find(c => c.name === 'Free space')?.tokens || 0,
                )}{' '}
                (
                {(
                  ((categories.find(c => c.name === 'Free space')?.tokens ||
                    0) /
                    rawMaxTokens) *
                  100
                ).toFixed(1)}
                %)
              </Text>
            </Box>
          )}
          {autocompactCategory && autocompactCategory.tokens > 0 && (
            <Box>
              <Text color={autocompactCategory.color}>⛝</Text>
              <Text dimColor> {autocompactCategory.name}: </Text>
              <Text dimColor>
                {formatTokens(autocompactCategory.tokens)} tokens (
                {((autocompactCategory.tokens / rawMaxTokens) * 100).toFixed(1)}
                %)
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginLeft={-1}>
        {mcpTools.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold>MCP tools</Text>
              <Text dimColor>
                {' '}
                · /mcp{hasDeferredMcpTools ? ' (loaded on-demand)' : ''}
              </Text>
            </Box>
            {!hasDeferredMcpTools &&
              Array.from(groupByServer(mcpTools).entries()).map(
                ([serverName, serverTools]) => {
                  const serverTotal = serverTools.reduce(
                    (s, t) => s + t.tokens,
                    0,
                  )
                  return (
                    <Box key={serverName} flexDirection="column" marginTop={1}>
                      <Box>
                        <Text dimColor>mcp__{serverName}</Text>
                        <Text dimColor>
                          {' '}
                          ({serverTools.length}{' '}
                          {plural(serverTools.length, 'tool')},{' '}
                          {formatTokens(serverTotal)} tokens)
                        </Text>
                      </Box>
                      {serverTools.map((tool, i) => (
                        <Box key={i}>
                          <Text>
                            └ {stripToolPrefix(tool.name, serverName)}:{' '}
                          </Text>
                          <Text dimColor>
                            {formatTokens(tool.tokens)} tokens
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  )
                },
              )}
            {hasDeferredMcpTools && mcpTools.some(t => t.isLoaded) && (
              <Box flexDirection="column">
                <Box marginTop={1}>
                  <Text dimColor>Loaded</Text>
                </Box>
                {Array.from(
                  groupByServer(mcpTools.filter(t => t.isLoaded)).entries(),
                ).map(([serverName, serverTools]) => {
                  const serverTotal = serverTools.reduce(
                    (s, t) => s + t.tokens,
                    0,
                  )
                  return (
                    <Box key={serverName} flexDirection="column" marginTop={1}>
                      <Box>
                        <Text dimColor>mcp__{serverName}</Text>
                        <Text dimColor>
                          {' '}
                          ({serverTools.length}{' '}
                          {plural(serverTools.length, 'tool')},{' '}
                          {formatTokens(serverTotal)} tokens)
                        </Text>
                      </Box>
                      {serverTools.map((tool, i) => (
                        <Box key={i}>
                          <Text>
                            └ {stripToolPrefix(tool.name, serverName)}:{' '}
                          </Text>
                          <Text dimColor>
                            {formatTokens(tool.tokens)} tokens
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  )
                })}
              </Box>
            )}
            {hasDeferredMcpTools && mcpTools.some(t => !t.isLoaded) && (
              <Box flexDirection="column">
                <Box marginTop={1}>
                  <Text dimColor>Available</Text>
                </Box>
                {Array.from(
                  groupByServer(mcpTools.filter(t => !t.isLoaded)).entries(),
                ).map(([serverName, serverTools]) => (
                  <Box key={serverName} flexDirection="column" marginTop={1}>
                    <Box>
                      <Text dimColor>mcp__{serverName}</Text>
                      <Text dimColor>
                        {' '}
                        ({serverTools.length}{' '}
                        {plural(serverTools.length, 'tool')})
                      </Text>
                    </Box>
                    {serverTools.map((tool, i) => (
                      <Box key={i}>
                        <Text dimColor>
                          └ {stripToolPrefix(tool.name, serverName)}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}

        {agents.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold>Custom agents</Text>
              <Text dimColor> · /agents</Text>
            </Box>
            {Array.from(groupBySource(agents).entries()).map(
              ([sourceDisplay, sourceAgents]) => (
                <Box key={sourceDisplay} flexDirection="column" marginTop={1}>
                  <Text dimColor>{sourceDisplay}</Text>
                  {sourceAgents.map((agent, i) => (
                    <Box key={i}>
                      <Text>└ {agent.agentType}: </Text>
                      <Text dimColor>{formatTokens(agent.tokens)} tokens</Text>
                    </Box>
                  ))}
                </Box>
              ),
            )}
          </Box>
        )}

        {memoryFiles.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold>Memory files</Text>
              <Text dimColor> · /memory</Text>
            </Box>
            {memoryFiles.map((file, i) => (
              <Box key={i}>
                <Text>└ {getDisplayPath(file.path)}: </Text>
                <Text dimColor>{formatTokens(file.tokens)} tokens</Text>
              </Box>
            ))}
          </Box>
        )}

        {skills && skills.tokens > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold>Skills</Text>
              <Text dimColor> · /skills</Text>
            </Box>
            {Array.from(groupBySource(skills.skillFrontmatter).entries()).map(
              ([sourceDisplay, sourceSkills]) => (
                <Box key={sourceDisplay} flexDirection="column" marginTop={1}>
                  <Text dimColor>{sourceDisplay}</Text>
                  {sourceSkills.map((skill, i) => (
                    <Box key={i}>
                      <Text>└ {skill.name}: </Text>
                      <Text dimColor>{formatTokens(skill.tokens)} tokens</Text>
                    </Box>
                  ))}
                </Box>
              ),
            )}
          </Box>
        )}
      </Box>
      <ContextSuggestions suggestions={generateContextSuggestions(data)} />
    </Box>
  )
}
