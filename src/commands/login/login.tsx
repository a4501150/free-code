import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text } from '../../ink.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { getProviderRegistry } from '../../utils/model/providerRegistry.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const registry = getProviderRegistry()
  const providers = registry.getAllProviders()

  // If multiple providers are configured, check if any need non-OAuth auth guidance
  const nonOAuthProviders: Array<{
    name: string
    authType: string
  }> = []
  for (const [name, config] of providers) {
    const authType = config.auth?.active
    if (
      authType &&
      authType !== 'oauth' &&
      authType !== 'apiKey'
    ) {
      nonOAuthProviders.push({ name, authType })
    }
  }

  // Show provider auth info panel if there are providers with cloud auth
  if (nonOAuthProviders.length > 0) {
    return (
      <ProviderAuthInfo
        providers={nonOAuthProviders}
        onDone={() => {
          // After showing info, proceed to Anthropic OAuth flow
          // (or just exit if no Anthropic provider)
          const hasAnthropicProvider = [...providers.values()].some(
            p => p.type === 'anthropic',
          )
          if (hasAnthropicProvider) {
            // Will re-render with the login flow below
          }
          onDone('Auth info displayed')
        }}
        onLoginAnthropic={async success => {
          handlePostLogin(success, context)
          onDone(success ? 'Login successful' : 'Login interrupted')
        }}
        hasAnthropicProvider={[...providers.values()].some(
          p => p.type === 'anthropic',
        )}
      />
    )
  }

  // Default: Anthropic OAuth login flow
  return (
    <Login
      onDone={async success => {
        handlePostLogin(success, context)
        onDone(success ? 'Login successful' : 'Login interrupted')
      }}
    />
  )
}

function handlePostLogin(
  success: boolean,
  context: LocalJSXCommandContext,
): void {
  context.onChangeAPIKey()
  context.setMessages(stripSignatureBlocks)
  if (success) {
    resetCostState()
    void refreshRemoteManagedSettings()
    void refreshPolicyLimits()
    resetUserCache()
    resetBypassPermissionsCheck()
    const appState = context.getAppState()
    void checkAndDisableBypassPermissionsIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
    )
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeGateCheck()
      void checkAndDisableAutoModeIfNeeded(
        appState.toolPermissionContext,
        context.setAppState,
        appState.fastMode,
      )
    }
    context.setAppState(prev => ({
      ...prev,
      authVersion: prev.authVersion + 1,
    }))
  }
}

function ProviderAuthInfo(props: {
  providers: Array<{ name: string; authType: string }>
  onDone: () => void
  onLoginAnthropic: (success: boolean) => void
  hasAnthropicProvider: boolean
}): React.ReactNode {
  const [showOAuth, setShowOAuth] = React.useState(false)
  const mainLoopModel = useMainLoopModel()

  if (showOAuth) {
    return (
      <Login
        onDone={success => props.onLoginAnthropic(success)}
      />
    )
  }

  const authInstructions: Record<string, string> = {
    aws: 'Configure via AWS CLI (aws configure) or environment variables',
    gcp: 'Run: gcloud auth application-default login',
    azure: 'Run: az login',
  }

  return (
    <Dialog
      title="Provider Authentication"
      onCancel={props.onDone}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <Text>
            {props.hasAnthropicProvider
              ? 'Press Enter to sign in with Anthropic, or Esc to dismiss'
              : 'Press Esc to dismiss'}
          </Text>
        )
      }
      onSubmit={
        props.hasAnthropicProvider
          ? () => setShowOAuth(true)
          : undefined
      }
    >
      <Box flexDirection="column" gap={1}>
        <Text bold>Configured Providers:</Text>
        {props.providers.map(p => (
          <Box key={p.name} flexDirection="column">
            <Text>
              <Text bold>{p.name}</Text>
              <Text dimColor> ({p.authType} auth)</Text>
            </Text>
            <Text dimColor>
              {' '}
              {authInstructions[p.authType] ||
                `Configure in freecode.json → providers.${p.name}.auth`}
            </Text>
          </Box>
        ))}
        {props.hasAnthropicProvider && (
          <Text dimColor>
            Press Enter to sign in with your Anthropic account
          </Text>
        )}
      </Box>
    </Dialog>
  )
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={() => props.onDone(true, mainLoopModel)}
        startingMessage={props.startingMessage}
      />
    </Dialog>
  )
}
