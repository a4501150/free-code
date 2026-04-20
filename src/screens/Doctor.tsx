import figures from 'figures'
import { join } from 'path'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { KeybindingWarnings } from 'src/components/KeybindingWarnings.js'
import { McpParsingWarnings } from 'src/components/mcp/McpParsingWarnings.js'
import { getModelMaxOutputTokens } from 'src/utils/context.js'
import { getWireModelId } from 'src/utils/model/modelIds.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { CommandResultDisplay } from '../commands.js'
import { Pane } from '../components/design-system/Pane.js'
import { PressEnterToContinue } from '../components/PressEnterToContinue.js'
import { SandboxDoctorSection } from '../components/sandbox/SandboxDoctorSection.js'
import { ValidationErrorsList } from '../components/ValidationErrorsList.js'
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState } from '../state/AppState.js'
import { getPluginErrorMessage } from '../types/plugin.js'
import {
  type ContextWarnings,
  checkContextWarnings,
} from '../utils/doctorContextWarnings.js'
import {
  type DiagnosticInfo,
  getDoctorDiagnostic,
} from '../utils/doctorDiagnostic.js'
import { validateBoundedIntEnvVar } from '../utils/envValidation.js'
import { pathExists } from '../utils/file.js'
import {
  BASH_MAX_OUTPUT_DEFAULT,
  BASH_MAX_OUTPUT_UPPER_LIMIT,
} from '../utils/shell/outputLimits.js'
import {
  TASK_MAX_OUTPUT_DEFAULT,
  TASK_MAX_OUTPUT_UPPER_LIMIT,
} from '../utils/task/outputFormatting.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type AgentInfo = {
  activeAgents: Array<{
    agentType: string
    source: SettingSource | 'built-in' | 'plugin'
  }>
  userAgentsDir: string
  projectAgentsDir: string
  userDirExists: boolean
  projectDirExists: boolean
  failedFiles?: Array<{ path: string; error: string }>
}


export function Doctor({ onDone }: Props): React.ReactNode {
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const mcpTools = useAppState(s => s.mcp.tools)
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const pluginsErrors = useAppState(s => s.plugins.errors)
  useExitOnCtrlCDWithKeybindings()

  const tools = useMemo(() => {
    return mcpTools || []
  }, [mcpTools])

  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo | null>(null)
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null)
  const [contextWarnings, setContextWarnings] =
    useState<ContextWarnings | null>(null)
  const validationErrors = useSettingsErrors()

  const errorsExcludingMcp = validationErrors.filter(
    error => error.mcpErrorMetadata === undefined,
  )

  const envValidationErrors = useMemo(() => {
    const envVars = [
      {
        name: 'BASH_MAX_OUTPUT_LENGTH',
        default: BASH_MAX_OUTPUT_DEFAULT,
        upperLimit: BASH_MAX_OUTPUT_UPPER_LIMIT,
      },
      {
        name: 'TASK_MAX_OUTPUT_LENGTH',
        default: TASK_MAX_OUTPUT_DEFAULT,
        upperLimit: TASK_MAX_OUTPUT_UPPER_LIMIT,
      },
      {
        name: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        default: getModelMaxOutputTokens(getWireModelId('claude-opus-4-6')),
        upperLimit: Number.MAX_SAFE_INTEGER,
      },
    ]
    return envVars
      .map(v => {
        const value = process.env[v.name]
        const result = validateBoundedIntEnvVar(
          v.name,
          value,
          v.default,
          v.upperLimit,
        )
        return { name: v.name, ...result }
      })
      .filter(v => v.status !== 'valid')
  }, [])

  useEffect(() => {
    void getDoctorDiagnostic().then(setDiagnostic)

    void (async () => {
      const userAgentsDir = join(getClaudeConfigHomeDir(), 'agents')
      const projectAgentsDir = join(getOriginalCwd(), '.claude', 'agents')

      const { activeAgents, allAgents, failedFiles } = agentDefinitions

      const [userDirExists, projectDirExists] = await Promise.all([
        pathExists(userAgentsDir),
        pathExists(projectAgentsDir),
      ])

      const agentInfoData = {
        activeAgents: activeAgents.map(a => ({
          agentType: a.agentType,
          source: a.source,
        })),
        userAgentsDir,
        projectAgentsDir,
        userDirExists,
        projectDirExists,
        failedFiles,
      }
      setAgentInfo(agentInfoData)

      const warnings = await checkContextWarnings(
        tools,
        {
          activeAgents,
          allAgents,
          failedFiles,
        },
        async () => toolPermissionContext,
      )
      setContextWarnings(warnings)
    })()
  }, [toolPermissionContext, tools, agentDefinitions])

  const handleDismiss = useCallback(() => {
    onDone('Claude Code diagnostics dismissed', { display: 'system' })
  }, [onDone])

  // Handle dismiss via keybindings (Enter, Escape, or Ctrl+C)
  useKeybindings(
    {
      'confirm:yes': handleDismiss,
      'confirm:no': handleDismiss,
    },
    { context: 'Confirmation' },
  )

  // Loading state
  if (!diagnostic) {
    return (
      <Pane>
        <Text dimColor>Checking installation status…</Text>
      </Pane>
    )
  }

  // Format the diagnostic output according to spec
  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>Diagnostics</Text>
        <Text>
          └ Currently running: {diagnostic.installationType} (
          {diagnostic.version})
        </Text>
        <Text>└ Path: {diagnostic.installationPath}</Text>
        <Text>└ Invoked: {diagnostic.invokedBinary}</Text>
        <Text>└ Config install method: {diagnostic.configInstallMethod}</Text>
        <Text>
          └ Search: {diagnostic.ripgrepStatus.working ? 'OK' : 'Not working'} (
          {diagnostic.ripgrepStatus.mode === 'embedded'
            ? 'bundled'
            : diagnostic.ripgrepStatus.mode === 'builtin'
              ? 'vendor'
              : diagnostic.ripgrepStatus.systemPath || 'system'}
          )
        </Text>

        {/* Show invalid settings errors */}
        {errorsExcludingMcp.length > 0 && (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text bold>Invalid Settings</Text>
            <ValidationErrorsList errors={errorsExcludingMcp} />
          </Box>
        )}
      </Box>

      <SandboxDoctorSection />

      <McpParsingWarnings />

      <KeybindingWarnings />

      {/* Environment Variables */}
      {envValidationErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Environment Variables</Text>
          {envValidationErrors.map((validation, i) => (
            <Text key={i}>
              └ {validation.name}:{' '}
              <Text
                color={validation.status === 'capped' ? 'warning' : 'error'}
              >
                {validation.message}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      {agentInfo?.failedFiles && agentInfo.failedFiles.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="error">
            Agent Parse Errors
          </Text>
          <Text color="error">
            └ Failed to parse {agentInfo.failedFiles.length} agent file(s):
          </Text>
          {agentInfo.failedFiles.map((file, i) => (
            <Text key={i} dimColor>
              {'  '}└ {file.path}: {file.error}
            </Text>
          ))}
        </Box>
      )}

      {/* Plugin Errors */}
      {pluginsErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="error">
            Plugin Errors
          </Text>
          <Text color="error">
            └ {pluginsErrors.length} plugin error(s) detected:
          </Text>
          {pluginsErrors.map((error, i) => (
            <Text key={i} dimColor>
              {'  '}└ {error.source || 'unknown'}
              {'plugin' in error && error.plugin ? ` [${error.plugin}]` : ''}:{' '}
              {getPluginErrorMessage(error)}
            </Text>
          ))}
        </Box>
      )}

      {/* Unreachable Permission Rules Warning */}
      {contextWarnings?.unreachableRulesWarning && (
        <Box flexDirection="column">
          <Text bold color="warning">
            Unreachable Permission Rules
          </Text>
          <Text>
            └{' '}
            <Text color="warning">
              {figures.warning}{' '}
              {contextWarnings.unreachableRulesWarning.message}
            </Text>
          </Text>
          {contextWarnings.unreachableRulesWarning.details.map((detail, i) => (
            <Text key={i} dimColor>
              {'  '}└ {detail}
            </Text>
          ))}
        </Box>
      )}

      {/* Context Usage Warnings */}
      {contextWarnings &&
        (contextWarnings.claudeMdWarning ||
          contextWarnings.agentWarning ||
          contextWarnings.mcpWarning) && (
          <Box flexDirection="column">
            <Text bold>Context Usage Warnings</Text>

            {contextWarnings.claudeMdWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    {figures.warning} {contextWarnings.claudeMdWarning.message}
                  </Text>
                </Text>
                <Text>{'  '}└ Files:</Text>
                {contextWarnings.claudeMdWarning.details.map((detail, i) => (
                  <Text key={i} dimColor>
                    {'    '}└ {detail}
                  </Text>
                ))}
              </>
            )}

            {contextWarnings.agentWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    {figures.warning} {contextWarnings.agentWarning.message}
                  </Text>
                </Text>
                <Text>{'  '}└ Top contributors:</Text>
                {contextWarnings.agentWarning.details.map((detail, i) => (
                  <Text key={i} dimColor>
                    {'    '}└ {detail}
                  </Text>
                ))}
              </>
            )}

            {contextWarnings.mcpWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    {figures.warning} {contextWarnings.mcpWarning.message}
                  </Text>
                </Text>
                <Text>{'  '}└ MCP servers:</Text>
                {contextWarnings.mcpWarning.details.map((detail, i) => (
                  <Text key={i} dimColor>
                    {'    '}└ {detail}
                  </Text>
                ))}
              </>
            )}
          </Box>
        )}

      <Box>
        <PressEnterToContinue />
      </Box>
    </Pane>
  )
}
