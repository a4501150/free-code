/**
 * Miscellaneous subcommand handlers — extracted from main.tsx for lazy loading.
 * setup-token, doctor, install
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import { cwd } from 'process'
import React from 'react'
import { WelcomeV2 } from '../../components/LogoV2/WelcomeV2.js'
import { useManagePlugins } from '../../hooks/useManagePlugins.js'
import type { Root } from '../../ink.js'
import { Box, Text } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'

import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js'
import { AppStateProvider } from '../../state/AppState.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { isAnthropicAuthEnabled } from '../../utils/auth.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'

export async function setupTokenHandler(root: Root): Promise<void> {
  const showAuthWarning = !isAnthropicAuthEnabled()
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider onChangeAppState={onChangeAppState}>
        <KeybindingSetup>
          <Box flexDirection="column" gap={1}>
            <WelcomeV2 />
            {showAuthWarning && (
              <Box flexDirection="column">
                <Text color="warning">
                  Warning: You already have authentication configured via
                  environment variable or API key helper.
                </Text>
                <Text color="warning">
                  The setup-token command will create a new OAuth token which
                  you can use instead.
                </Text>
              </Box>
            )}
            <ConsoleOAuthFlow
              onDone={() => {
                void resolve()
              }}
              mode="setup-token"
              startingMessage="This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required."
            />
          </Box>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  process.exit(0)
}

// DoctorWithPlugins wrapper + doctor handler
const DoctorLazy = React.lazy(() =>
  import('../../screens/Doctor.js').then(m => ({ default: m.Doctor })),
)

function DoctorWithPlugins({
  onDone,
}: {
  onDone: () => void
}): React.ReactNode {
  useManagePlugins()
  return (
    <React.Suspense fallback={null}>
      <DoctorLazy onDone={onDone} />
    </React.Suspense>
  )
}

export async function doctorHandler(root: Root): Promise<void> {
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <MCPConnectionManager
            dynamicMcpConfig={undefined}
            isStrictMcpConfig={false}
          >
            <DoctorWithPlugins
              onDone={() => {
                void resolve()
              }}
            />
          </MCPConnectionManager>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  process.exit(0)
}
