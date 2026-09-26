import React, { useCallback, useMemo } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { Box, Text, useTheme } from '../../ink.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { splitMcpDisplayName } from '../../services/mcp/mcpStringUtils.js'
import {
  type PermissionRequestEvent,
  usePermissionRequestLogging,
} from './hooks.js'
import { PermissionDialog } from './PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from './PermissionPrompt.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'

type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function FallbackPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose: _verbose,
}: PermissionRequestProps): React.ReactNode {
  const [theme] = useTheme()
  // The dialog renders MCP tools as "<base name>(<args>) (MCP)" with the
  // suffix dimmed. The MCP marker currently lives inside the single display
  // string userFacingName() returns, so it has to be split back out here
  // (shared helper below keeps the two slices in sync).
  const originalUserFacingName = toolUseConfirm.tool.userFacingName(
    toolUseConfirm.input as never,
  )
  const { base: userFacingName, isMcp } = splitMcpDisplayName(
    originalUserFacingName,
  )

  const permissionEvent = useMemo<PermissionRequestEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, permissionEvent)

  const handleSelect = useCallback(
    (value: FallbackOptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-dont-ask-again': {
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [
                {
                  toolName: toolUseConfirm.tool.name,
                },
              ],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        }
        case 'no':
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject],
  )

  const handleCancel = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  const originalCwd = getOriginalCwd()
  const options = useMemo((): PermissionPromptOption<FallbackOptionValue>[] => {
    const result: PermissionPromptOption<FallbackOptionValue>[] = [
      {
        label: 'Yes',
        value: 'yes',
        feedbackConfig: { type: 'accept' },
      },
    ]

    result.push({
      label: (
        <Text>
          Yes, and don&apos;t ask again for <Text bold>{userFacingName}</Text>{' '}
          commands in <Text bold>{originalCwd}</Text>
        </Text>
      ),
      value: 'yes-dont-ask-again',
    })

    result.push({
      label: 'No',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })

    return result
  }, [userFacingName, originalCwd])

  const toolAnalyticsContext = useMemo(
    (): ToolAnalyticsContext => ({
      toolName: toolUseConfirm.tool.name,
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  return (
    <PermissionDialog title="Tool use">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {userFacingName}(
          {toolUseConfirm.tool.renderToolUseMessage(
            toolUseConfirm.input as never,
            { theme, verbose: true },
          )}
          ){isMcp ? <Text dimColor> (MCP)</Text> : ''}
        </Text>
        <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}
