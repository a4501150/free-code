import { useState, useRef, useCallback, useEffect } from 'react'
import { consumeEarlyInput } from '../../utils/earlyInput.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'

const PROMPT_SUPPRESSION_MS = 1500

export function useReplInput({
  repinScroll,
  lastUserScrollTsRef,
  recentScrollRepinWindowMs,
  trySuggestBgPRIntercept,
}: {
  repinScroll: () => void
  lastUserScrollTsRef: React.RefObject<number>
  recentScrollRepinWindowMs: number
  trySuggestBgPRIntercept: (prev: string, next: string) => boolean
}) {
  const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput())
  const inputValueRef = useRef(inputValue)
  inputValueRef.current = inputValue
  const insertTextRef = useRef<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>(null)

  const [isPromptInputActive, setIsPromptInputActive] = useState(false)

  const setInputValue = useCallback(
    (value: string) => {
      if (trySuggestBgPRIntercept(inputValueRef.current, value)) return
      if (
        inputValueRef.current === '' &&
        value !== '' &&
        Date.now() - lastUserScrollTsRef.current >= recentScrollRepinWindowMs
      ) {
        repinScroll()
      }
      inputValueRef.current = value
      setInputValueRaw(value)
      setIsPromptInputActive(value.trim().length > 0)
    },
    [
      setIsPromptInputActive,
      repinScroll,
      trySuggestBgPRIntercept,
      lastUserScrollTsRef,
      recentScrollRepinWindowMs,
    ],
  )

  useEffect(() => {
    if (inputValue.trim().length === 0) return
    const timer = setTimeout(
      setIsPromptInputActive,
      PROMPT_SUPPRESSION_MS,
      false,
    )
    return () => clearTimeout(timer)
  }, [inputValue])

  const [inputMode, setInputMode] = useState<PromptInputMode>('prompt')
  const [stashedPrompt, setStashedPrompt] = useState<
    | {
        text: string
        cursorOffset: number
        pastedContents: Record<number, PastedContent>
      }
    | undefined
  >()

  const [pastedContents, setPastedContents] = useState<
    Record<number, PastedContent>
  >({})
  const [submitCount, setSubmitCount] = useState(0)

  const [vimMode, setVimMode] = useState<VimMode>('INSERT')
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(
    false,
  )
  const [isSearchingHistory, setIsSearchingHistory] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)

  const restoreStashedPrompt = useCallback(
    (helpers?: {
      setCursorOffset: (offset: number) => void
      clearBuffer?: () => void
    }) => {
      if (stashedPrompt === undefined) return false
      setInputValue(stashedPrompt.text)
      helpers?.setCursorOffset(stashedPrompt.cursorOffset)
      setPastedContents(stashedPrompt.pastedContents)
      setStashedPrompt(undefined)
      return true
    },
    [stashedPrompt, setInputValue],
  )

  return {
    inputValue,
    inputValueRef,
    setInputValue,
    setInputValueRaw,
    insertTextRef,
    isPromptInputActive,
    setIsPromptInputActive,
    inputMode,
    setInputMode,
    stashedPrompt,
    setStashedPrompt,
    pastedContents,
    setPastedContents,
    submitCount,
    setSubmitCount,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    isSearchingHistory,
    setIsSearchingHistory,
    isHelpOpen,
    setIsHelpOpen,
    restoreStashedPrompt,
  }
}
