/**
 * The classic REPL's ComposerHost: every action is the same closure
 * PromptInput used to receive directly — the interface is a routing change,
 * not a behavior change. See components/PromptInput/composerHost.ts for the
 * seam and its shared-process store contract.
 */
import { useMemo } from 'react'
import type { ComposerHost } from '../../components/PromptInput/composerHost.js'
import { startUserInputAttachmentPrefetch } from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import {
  cyclePermissionMode,
  getNextPermissionMode,
} from '../../utils/permissions/getNextPermissionMode.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import { useAppStateStore } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import type { ActiveSpeculationState } from '../../services/PromptSuggestion/speculation.js'
import type { Message } from '../../types/message.js'

type Deps = {
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: ActiveSpeculationState
      speculationSessionTimeSavedMs: number
      setAppState: SetAppState
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  onAgentSubmit: (
    input: string,
    task: LocalAgentTaskState,
    helpers: PromptInputHelpers,
  ) => Promise<void>
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  setAppState: SetAppState
  setToolPermissionContext: (ctx: ToolPermissionContext) => void
}

export function useReplComposerHost({
  onSubmit,
  onAgentSubmit,
  getToolUseContext,
  setAppState,
  setToolPermissionContext,
}: Deps): ComposerHost {
  const store = useAppStateStore()
  return useMemo<ComposerHost>(
    () => ({
      submit: (input, helpers, speculationAccept, options) =>
        onSubmit(
          input,
          helpers,
          // The old prop payload carried the host's mutator; the host now
          // supplies its own.
          speculationAccept && {
            ...speculationAccept,
            setAppState,
          },
          options,
        ),
      submitToAgent: (input, target, helpers) => {
        // Same-tick re-read of what the composer already showed as the
        // steering target.
        const task = store.getState().tasks[target.id]
        if (task && isLocalAgentTask(task)) {
          return onAgentSubmit(input, task, helpers)
        }
        return Promise.resolve()
      },
      prefetchAttachments: (value, messages, mainLoopModel) =>
        startUserInputAttachmentPrefetch(
          value,
          getToolUseContext,
          messages,
          mainLoopModel,
        ),
      cyclePermissionMode: ctx => {
        // Compute the next mode without triggering side effects first.
        logForDebugging(
          `[auto-mode] handleCycleMode: currentMode=${ctx.mode} isAutoModeAvailable=${ctx.isAutoModeAvailable}`,
        )
        const nextMode = getNextPermissionMode(ctx)

        const { context: preparedContext } = cyclePermissionMode(ctx)

        // Set the mode via setAppState directly because setToolPermissionContext
        // intentionally preserves the existing mode (to prevent coordinator mode
        // corruption from workers). Then call setToolPermissionContext to trigger
        // recheck of queued permission prompts.
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...preparedContext,
            mode: nextMode,
          },
        }))
        setToolPermissionContext({
          ...preparedContext,
          mode: nextMode,
        })
      },
    }),
    [
      onSubmit,
      onAgentSubmit,
      getToolUseContext,
      setAppState,
      setToolPermissionContext,
      store,
    ],
  )
}
