import * as React from 'react'
import { useMemo } from 'react'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AnimatedTerminalTitle } from './AnimatedTerminalTitle.js'
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js'
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js'
import { ScrollKeybindingHandler } from '../ScrollKeybindingHandler.js'
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js'
import { MessageActionsKeybindings } from '../messageActions.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { useVoiceKeybindingHandler } from '../../hooks/useVoiceIntegration.js'
import { useBackgroundTaskNavigation } from '../../hooks/useBackgroundTaskNavigation.js'
import {
  PromptKeyDownContext,
  type PromptKeyDownHandler,
} from './PromptKeyDownContext.js'

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
  globalKeybindingProps: any
  voice: any
  toolJSX: any
  onSubmit: any
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  scrollIsActive: boolean
  scrollIsModal?: boolean
  scrollOnScroll?:
    | ((sticky: boolean, handle: ScrollBoxHandle) => void)
    | undefined
  cancelRequestProps: any
  messageActionHandlers?: any
  disableMessageActions?: boolean
  cursor?: any
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
