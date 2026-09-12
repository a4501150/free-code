import * as React from 'react'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AnimatedTerminalTitle } from './AnimatedTerminalTitle.js'
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js'
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js'
import { ScrollKeybindingHandler } from '../ScrollKeybindingHandler.js'
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js'
import { MessageActionsKeybindings } from '../messageActions.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { VoiceKeybindingHandler } from '../../hooks/useVoiceIntegration.js'

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
  children: React.ReactNode
}): React.ReactNode {
  return (
    <KeybindingSetup>
      <AnimatedTerminalTitle
        isAnimating={titleIsAnimating}
        title={terminalTitle}
        disabled={titleDisabled}
        noPrefix={showStatusInTerminalTab}
      />
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      <VoiceKeybindingHandler
        voiceHandleKeyEvent={voice.handleKeyEvent}
        stripTrailing={voice.stripTrailing}
        resetAnchor={voice.resetAnchor}
        isActive={!toolJSX?.isLocalJSXCommand}
      />
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
  )
}
