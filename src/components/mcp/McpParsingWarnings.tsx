import React, { useMemo } from 'react'
import {
  getMcpConfigsByScope,
  isMcpServerDisabled,
} from 'src/services/mcp/config.js'
import type { ConfigScope } from 'src/services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  getProjectMcpServerStatus,
  getScopeLabel,
} from 'src/services/mcp/utils.js'
import type { ValidationError } from 'src/utils/settings/validation.js'
import { Box, Link, Text } from '../../ink.js'

function McpConfigErrorSection({
  scope,
  parsingErrors,
  warnings,
}: {
  scope: ConfigScope
  parsingErrors: ValidationError[]
  warnings: ValidationError[]
}): React.ReactNode {
  const hasErrors = parsingErrors.length > 0
  const hasWarnings = warnings.length > 0

  if (!hasErrors && !hasWarnings) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {(hasErrors || hasWarnings) && (
          <Text color={hasErrors ? 'error' : 'warning'}>
            [{hasErrors ? 'Failed to parse' : 'Contains warnings'}]{' '}
          </Text>
        )}
        <Text>{getScopeLabel(scope)}</Text>
      </Box>
      <Box>
        <Text dimColor>Location: </Text>
        <Text dimColor>{describeMcpConfigFilePath(scope)}</Text>
      </Box>
      <Box marginLeft={1} flexDirection="column">
        {parsingErrors.map((error, i) => {
          const serverName = error.mcpErrorMetadata?.serverName
          return (
            <Box key={`error-${i}`}>
              <Text>
                <Text dimColor>└ </Text>
                <Text color="error">[Error]</Text>
                <Text dimColor>
                  {' '}
                  {serverName && `[${serverName}] `}
                  {error.path && error.path !== '' ? `${error.path}: ` : ''}
                  {error.message}
                </Text>
              </Text>
            </Box>
          )
        })}
        {warnings.map((warning, i) => {
          const serverName = warning.mcpErrorMetadata?.serverName

          return (
            <Box key={`warning-${i}`}>
              <Text>
                <Text dimColor>└ </Text>
                <Text color="warning">[Warning]</Text>
                <Text dimColor>
                  {' '}
                  {serverName && `[${serverName}] `}
                  {warning.path && warning.path !== ''
                    ? `${warning.path}: `
                    : ''}
                  {warning.message}
                </Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

/**
 * Servers defined in more than one scope are shadowed by the higher-priority
 * definition — surface the name, every defining file, and the approval /
 * disabled state that applies to it, so "why is my server not the one I
 * edited" is answerable from this screen alone.
 */
function DuplicateServerNamesSection({
  scopes,
}: {
  scopes: Array<{ scope: ConfigScope; serverNames: string[] }>
}): React.ReactNode {
  const duplicates = useMemo(() => {
    const scopesByName = new Map<string, ConfigScope[]>()
    for (const { scope, serverNames } of scopes) {
      for (const name of serverNames) {
        scopesByName.set(name, [...(scopesByName.get(name) ?? []), scope])
      }
    }
    return [...scopesByName].filter(([, definers]) => definers.length > 1)
  }, [scopes])

  if (duplicates.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="warning">[Duplicate server names] </Text>
        <Text>
          Servers defined in multiple scopes are shadowed by the higher-priority
          definition
        </Text>
      </Box>
      {duplicates.map(([name, definers]) => (
        <Box key={name} flexDirection="column" marginLeft={1}>
          <Box flexDirection="column">
            <Text>
              <Text dimColor>└ </Text>
              <Text>{name}</Text>
              {isMcpServerDisabled(name) ? (
                <Text color="warning"> [disabled]</Text>
              ) : null}
            </Text>
            {definers.map(scope => (
              <Box key={scope} marginLeft={2}>
                <Text dimColor>
                  {getScopeLabel(scope)}: {describeMcpConfigFilePath(scope)}
                  {scope !== 'user'
                    ? ` · approval: ${getProjectMcpServerStatus(name)}`
                    : ''}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export function McpParsingWarnings(): React.ReactNode {
  // Config files don't change during dialog lifetime; read once on mount
  // to avoid blocking file IO on every re-render.
  const scopes = useMemo(
    () =>
      [
        { scope: 'user', config: getMcpConfigsByScope('user') },
        { scope: 'project', config: getMcpConfigsByScope('project') },
        { scope: 'local', config: getMcpConfigsByScope('local') },
      ] satisfies Array<{
        scope: ConfigScope
        config: { errors: ValidationError[] }
      }>,
    [],
  )

  const hasParsingErrors = scopes.some(
    ({ config }) => filterErrors(config.errors, 'fatal').length > 0,
  )
  const hasWarnings = scopes.some(
    ({ config }) => filterErrors(config.errors, 'warning').length > 0,
  )
  const hasDuplicates =
    new Set(scopes.flatMap(({ config }) => Object.keys(config.servers))).size <
    scopes.reduce(
      (total, { config }) => total + Object.keys(config.servers).length,
      0,
    )

  if (!hasParsingErrors && !hasWarnings && !hasDuplicates) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold>MCP Config Diagnostics</Text>
      <Box marginTop={1}>
        <Text dimColor>
          For help configuring MCP servers, see:{' '}
          <Link url="https://code.claude.com/docs/en/mcp">
            https://code.claude.com/docs/en/mcp
          </Link>
        </Text>
      </Box>
      {scopes.map(({ scope, config }) => (
        <McpConfigErrorSection
          key={scope}
          scope={scope}
          parsingErrors={filterErrors(config.errors, 'fatal')}
          warnings={filterErrors(config.errors, 'warning')}
        />
      ))}
      <DuplicateServerNamesSection
        scopes={scopes.map(({ scope, config }) => ({
          scope,
          serverNames: Object.keys(config.servers),
        }))}
      />
    </Box>
  )
}

function filterErrors(
  errors: ValidationError[],
  severity: 'fatal' | 'warning',
): ValidationError[] {
  return errors.filter(e => e.mcpErrorMetadata?.severity === severity)
}
