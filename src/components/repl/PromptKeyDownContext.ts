import { createContext, useContext } from 'react'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'

export type PromptKeyDownHandler = (e: KeyboardEvent) => void

/**
 * REPL-level onKeyDown handlers (voice hold-to-talk, background-task nav)
 * that need to run on the keyboard tree but live above PromptInput in the
 * component tree. ReplKeybindingShell provides them; PromptInput composes
 * them onto its dispatch-target container so tree-dispatched keydowns
 * reach them (context renders no DOM node — zero layout impact).
 */
export const PromptKeyDownContext = createContext<
  readonly PromptKeyDownHandler[] | null
>(null)

export function usePromptForwardedKeyDown(): readonly PromptKeyDownHandler[] {
  return useContext(PromptKeyDownContext) ?? []
}
