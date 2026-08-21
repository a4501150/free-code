import * as React from 'react'
import { useState, useRef, useCallback } from 'react'

export type ToolJSXState = {
  jsx: React.ReactNode | null
  shouldHidePromptInput: boolean
  shouldContinueAnimation?: true
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  isImmediate?: boolean
} | null

export type SetToolJSXArgs = {
  jsx: React.ReactNode | null
  shouldHidePromptInput: boolean
  shouldContinueAnimation?: true
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  clearLocalJSX?: boolean
  isImmediate?: boolean
} | null

export function useReplToolJSX() {
  const [toolJSX, setToolJSXInternal] = useState<ToolJSXState>(null)

  const localJSXCommandRef = useRef<{
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand: true
  } | null>(null)

  const setToolJSX = useCallback((args: SetToolJSXArgs) => {
    if (args?.isLocalJSXCommand) {
      const { clearLocalJSX: _, ...rest } = args
      localJSXCommandRef.current = { ...rest, isLocalJSXCommand: true }
      setToolJSXInternal(rest)
      return
    }

    if (localJSXCommandRef.current) {
      if (args?.clearLocalJSX) {
        localJSXCommandRef.current = null
        setToolJSXInternal(null)
        return
      }
      return
    }

    if (args?.clearLocalJSX) {
      setToolJSXInternal(null)
      return
    }
    setToolJSXInternal(args)
  }, [])

  const isShowingLocalJSXCommand =
    toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null

  return {
    toolJSX,
    setToolJSX,
    isShowingLocalJSXCommand,
  }
}
