import * as React from 'react'
import { useMemo } from 'react'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AnimatedTerminalTitle } from './AnimatedTerminalTitle.js'
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js'
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js'
import { ScrollKeybindingHandler } from '../ScrollKeybindingHandler.js'
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js'
import {
  type MessageActionsState,
  MessageActionsKeybindings,
} from '../messageActions.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { useVoiceKeybindingHandler } from '../../hooks/useVoiceIntegration.js'
import { useBackgroundTaskNavigation } from '../../hooks/useBackgroundTaskNavigation.js'
import type { ToolJSXState } from '../../hooks/repl/useReplToolJSX.js'
import {
  PromptKeyDownContext,
  type PromptKeyDownHandler,
} from './PromptKeyDownContext.js'

/** The three voice-controller members the shell forwards to the keybinding hook. */
type VoiceKeybindingProps = Parameters<typeof useVoiceKeybindingHandler>[0]

export function ReplKeybindingShell({
  titleIsAnimating,
  terminalTitle,
  titleDisabled,
  showStatusInTerminalTab,
  globalKeybindingProps,
  voice,
  toolJSX,
  onSubmit,
  scrollRef,
  scrollIsActive,
  scrollIsModal,
  scrollOnScroll,
  cancelRequestProps,
  messageActionHandlers,
  disableMessageActions,
  cursor,
  onOpenBackgroundTasks,
  children,
}: {
  titleIsAnimating: boolean
  terminalTitle: string
  titleDisabled: boolean
  showStatusInTerminalTab: boolean
  globalKeybindingProps: React.ComponentProps<typeof GlobalKeybindingHandlers>
  voice: {
    handleKeyEvent: VoiceKeybindingProps['voiceHandleKeyEvent']
    stripTrailing: VoiceKeybindingProps['stripTrailing']
    resetAnchor: VoiceKeybindingProps['resetAnchor']
  }
  toolJSX: ToolJSXState
  onSubmit: React.ComponentProps<typeof CommandKeybindingHandlers>['onSubmit']
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  scrollIsActive: boolean
  scrollIsModal?: boolean
  scrollOnScroll?:
    | ((sticky: boolean, handle: ScrollBoxHandle) => void)
    | undefined
  cancelRequestProps: React.ComponentProps<typeof CancelRequestHandler>
  messageActionHandlers?: Record<string, () => void>
  disableMessageActions?: boolean
  cursor?: MessageActionsState | null
  /** Undefined when a local-jsx dialog is open (Shift+Down would stack dialogs). */
  onOpenBackgroundTasks?: () => void
  children: React.ReactNode
}): React.ReactNode {
  // Keyboard handlers that must run on the tree but live above PromptInput:
  // they're forwarded through PromptKeyDownContext onto the prompt
  // container's onKeyDown (the FocusManager default target), which runs
  // before every useInput listener.
  const voiceKb = useVoiceKeybindingHandler({
    voiceHandleKeyEvent: voice.handleKeyEvent,
    stripTrailing: voice.stripTrailing,
    resetAnchor: voice.resetAnchor,
    isActive: !toolJSX?.isLocalJSXCommand,
  })
  const bgNav = useBackgroundTaskNavigation({
    onOpenBackgroundTasks,
  })
  const forwarded = useMemo<PromptKeyDownHandler[]>(
    () => [voiceKb.handleKeyDown, bgNav.handleKeyDown],
    [voiceKb.handleKeyDown, bgNav.handleKeyDown],
  )
  return (
    <PromptKeyDownContext.Provider value={forwarded}>
      <KeybindingSetup>
        <AnimatedTerminalTitle
          isAnimating={titleIsAnimating}
          title={terminalTitle}
          disabled={titleDisabled}
          noPrefix={showStatusInTerminalTab}
        />
        <GlobalKeybindingHandlers {...globalKeybindingProps} />
        <CommandKeybindingHandlers
          onSubmit={onSubmit}
          isActive={!toolJSX?.isLocalJSXCommand}
        />
        <ScrollKeybindingHandler
          scrollRef={scrollRef}
          isActive={scrollIsActive}
          isModal={scrollIsModal}
          onScroll={scrollOnScroll}
        />
        {!disableMessageActions && messageActionHandlers ? (
          <MessageActionsKeybindings
            handlers={messageActionHandlers}
            isActive={cursor !== null}
          />
        ) : null}
        <CancelRequestHandler {...cancelRequestProps} />
        {children}
      </KeybindingSetup>
    </PromptKeyDownContext.Provider>
  )
}
