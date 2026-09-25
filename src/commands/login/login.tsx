import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { LoginChooser } from '../../components/LoginChooser.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '../../ink.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
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
    void refreshPolicyLimits()
    resetUserCache()
    resetBypassPermissionsCheck()
    const appState = context.getAppState()
    void checkAndDisableBypassPermissionsIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
    )
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
    context.setAppState(prev => ({
      ...prev,
      authVersion: prev.authVersion + 1,
    }))
  }
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
            description="cancel"
          />
        )
      }
    >
      <LoginChooser
        onDone={() => props.onDone(true, mainLoopModel)}
        startingMessage={props.startingMessage}
      />
    </Dialog>
  )
}
