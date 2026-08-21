import * as React from 'react'
import { feature } from 'bun:bundle'
import { Box } from '../../ink.js'
import { SandboxPermissionRequest } from '../permissions/SandboxPermissionRequest.js'
import { PromptDialog } from '../hooks/PromptDialog.js'
import { WorkerPendingPermission } from '../permissions/WorkerPendingPermission.js'
import { ElicitationDialog } from '../mcp/ElicitationDialog.js'
import { IdeOnboardingDialog } from '../IdeOnboardingDialog.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import { sendSandboxPermissionResponseViaMailbox } from '../../utils/swarm/permissionSync.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import type { NetworkHostPattern } from '../../utils/sandbox/sandbox-adapter.js'
import type { PromptRequest, PromptResponse } from '../../types/hooks.js'

export function ReplDialogLayer({
  focusedInputDialog,
  sandboxPermissionRequestQueue,
  setSandboxPermissionRequestQueue,
  setAppState,
  promptQueue,
  setPromptQueue,
  pendingWorkerRequest,
  pendingSandboxRequest,
  workerSandboxPermissions,
  elicitation,
  showIdeOnboarding,
  setShowIdeOnboarding,
  ideInstallationStatus,
  teamContext,
  exitFlow,
  mrRender,
  permissionStickyFooter,
  toolJSX,
  toolJsxCentered,
  showSpinner,
  showExpandedTodos,
  tasksV2,
}: {
  focusedInputDialog: string | undefined
  sandboxPermissionRequestQueue: Array<{
    hostPattern: NetworkHostPattern
    resolvePromise: (allowConnection: boolean) => void
  }>
  setSandboxPermissionRequestQueue: React.Dispatch<
    React.SetStateAction<
      Array<{
        hostPattern: NetworkHostPattern
        resolvePromise: (allowConnection: boolean) => void
      }>
    >
  >
  setAppState: (fn: (prev: any) => any) => void
  promptQueue: Array<{
    request: PromptRequest
    title: string
    toolInputSummary?: string | null
    resolve: (response: PromptResponse) => void
    reject: (error: Error) => void
  }>
  setPromptQueue: React.Dispatch<
    React.SetStateAction<
      Array<{
        request: PromptRequest
        title: string
        toolInputSummary?: string | null
        resolve: (response: PromptResponse) => void
        reject: (error: Error) => void
      }>
    >
  >
  pendingWorkerRequest: any
  pendingSandboxRequest: any
  workerSandboxPermissions: any
  elicitation: any
  showIdeOnboarding: boolean
  setShowIdeOnboarding: (v: boolean) => void
  ideInstallationStatus: any
  teamContext: any
  exitFlow: React.ReactNode
  mrRender: () => React.ReactNode
  permissionStickyFooter: React.ReactNode | null
  toolJSX: any
  toolJsxCentered: boolean
  showSpinner: unknown
  showExpandedTodos: boolean
  tasksV2: any
}): React.ReactNode {
  return (
    <>
      {permissionStickyFooter}
      {toolJSX?.isLocalJSXCommand &&
        toolJSX.isImmediate &&
        !toolJsxCentered && (
          <Box flexDirection="column" width="100%">
            {toolJSX.jsx}
          </Box>
        )}
      {!showSpinner &&
        !toolJSX?.isLocalJSXCommand &&
        showExpandedTodos &&
        tasksV2 &&
        tasksV2.length > 0 && (
          <Box width="100%" flexDirection="column">
            {/* TaskListV2 imported by caller */}
          </Box>
        )}
      {focusedInputDialog === 'sandbox-permission' && (
        <SandboxPermissionRequest
          key={sandboxPermissionRequestQueue[0]!.hostPattern.host}
          hostPattern={sandboxPermissionRequestQueue[0]!.hostPattern}
          onUserResponse={(response: {
            allow: boolean
            persistToSettings: boolean
          }) => {
            const { allow, persistToSettings } = response
            const currentRequest = sandboxPermissionRequestQueue[0]
            if (!currentRequest) return
            const approvedHost = currentRequest.hostPattern.host
            if (persistToSettings) {
              const update = {
                type: 'addRules' as const,
                rules: [
                  {
                    toolName: WEB_FETCH_TOOL_NAME,
                    ruleContent: `domain:${approvedHost}`,
                  },
                ],
                behavior: (allow ? 'allow' : 'deny') as 'allow' | 'deny',
                destination: 'localSettings' as const,
              }
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(
                  prev.toolPermissionContext,
                  update,
                ),
              }))
              persistPermissionUpdate(update)
              SandboxManager.refreshConfig()
            }
            setSandboxPermissionRequestQueue(queue => {
              queue
                .filter(item => item.hostPattern.host === approvedHost)
                .forEach(item => item.resolvePromise(allow))
              return queue.filter(
                item => item.hostPattern.host !== approvedHost,
              )
            })
          }}
        />
      )}
      {focusedInputDialog === 'prompt' && (
        <PromptDialog
          key={promptQueue[0]!.request.prompt}
          title={promptQueue[0]!.title}
          toolInputSummary={promptQueue[0]!.toolInputSummary}
          request={promptQueue[0]!.request}
          onRespond={selectedKey => {
            const item = promptQueue[0]
            if (!item) return
            item.resolve({
              prompt_response: item.request.prompt,
              selected: selectedKey,
            })
            setPromptQueue(([, ...tail]) => tail)
          }}
          onAbort={() => {
            const item = promptQueue[0]
            if (!item) return
            item.reject(new Error('Prompt cancelled by user'))
            setPromptQueue(([, ...tail]) => tail)
          }}
        />
      )}
      {pendingWorkerRequest && (
        <WorkerPendingPermission
          toolName={pendingWorkerRequest.toolName}
          description={pendingWorkerRequest.description}
        />
      )}
      {pendingSandboxRequest && (
        <WorkerPendingPermission
          toolName="Network Access"
          description={`Waiting for leader to approve network access to ${pendingSandboxRequest.host}`}
        />
      )}
      {focusedInputDialog === 'worker-sandbox-permission' && (
        <SandboxPermissionRequest
          key={workerSandboxPermissions.queue[0]!.requestId}
          hostPattern={
            {
              host: workerSandboxPermissions.queue[0]!.host,
              port: undefined,
            } as NetworkHostPattern
          }
          onUserResponse={(response: {
            allow: boolean
            persistToSettings: boolean
          }) => {
            const { allow, persistToSettings } = response
            const currentRequest = workerSandboxPermissions.queue[0]
            if (!currentRequest) return
            const approvedHost = currentRequest.host
            void sendSandboxPermissionResponseViaMailbox(
              currentRequest.workerName,
              currentRequest.requestId,
              approvedHost,
              allow,
              teamContext?.teamName,
            )
            if (persistToSettings && allow) {
              const update = {
                type: 'addRules' as const,
                rules: [
                  {
                    toolName: WEB_FETCH_TOOL_NAME,
                    ruleContent: `domain:${approvedHost}`,
                  },
                ],
                behavior: 'allow' as const,
                destination: 'localSettings' as const,
              }
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(
                  prev.toolPermissionContext,
                  update,
                ),
              }))
              persistPermissionUpdate(update)
              SandboxManager.refreshConfig()
            }
            setAppState(prev => ({
              ...prev,
              workerSandboxPermissions: {
                ...prev.workerSandboxPermissions,
                queue: prev.workerSandboxPermissions.queue.slice(1),
              },
            }))
          }}
        />
      )}
      {focusedInputDialog === 'elicitation' && (
        <ElicitationDialog
          key={
            elicitation.queue[0]!.serverName +
            ':' +
            String(elicitation.queue[0]!.requestId)
          }
          event={elicitation.queue[0]!}
          onResponse={(action, content) => {
            const currentRequest = elicitation.queue[0]
            if (!currentRequest) return
            currentRequest.respond({ action, content })
            const isUrlAccept =
              currentRequest.params.mode === 'url' && action === 'accept'
            if (!isUrlAccept) {
              setAppState(prev => ({
                ...prev,
                elicitation: {
                  queue: prev.elicitation.queue.slice(1),
                },
              }))
            }
          }}
          onWaitingDismiss={action => {
            const currentRequest = elicitation.queue[0]
            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: prev.elicitation.queue.slice(1),
              },
            }))
            currentRequest?.onWaitingDismiss?.(action)
          }}
        />
      )}
      {focusedInputDialog === 'ide-onboarding' && (
        <IdeOnboardingDialog
          onDone={() => setShowIdeOnboarding(false)}
          installationStatus={ideInstallationStatus}
        />
      )}
      {exitFlow}
      {mrRender()}
    </>
  )
}
