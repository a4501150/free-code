import * as React from 'react'
import { feature } from 'bun:bundle'
import { Box } from '../../ink.js'
import { PromptDialog } from '../hooks/PromptDialog.js'
import { ElicitationDialog } from '../mcp/ElicitationDialog.js'
import { IdeOnboardingDialog } from '../IdeOnboardingDialog.js'
import type { PromptRequest, PromptResponse } from '../../types/hooks.js'

export function ReplDialogLayer({
  focusedInputDialog,
  setAppState,
  promptQueue,
  setPromptQueue,
  elicitation,
  showIdeOnboarding,
  setShowIdeOnboarding,
  ideInstallationStatus,
  exitFlow,
  mrRender,
  permissionStickyFooter,
  toolJSX,
  toolJsxCentered,
}: {
  focusedInputDialog: string | undefined
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
  elicitation: any
  showIdeOnboarding: boolean
  setShowIdeOnboarding: (v: boolean) => void
  ideInstallationStatus: any
  exitFlow: React.ReactNode
  mrRender: () => React.ReactNode
  permissionStickyFooter: React.ReactNode | null
  toolJSX: any
  toolJsxCentered: boolean
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
