import * as React from 'react'
import { useState, useCallback } from 'react'
import exit from '../../commands/exit/index.js'
import { ExitFlow } from '../../components/ExitFlow.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

export function useReplExit() {
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null)
  const [isExiting, setIsExiting] = useState(false)

  const handleExit = useCallback(async () => {
    setIsExiting(true)
    const showWorktree = getCurrentWorktreeSession() !== null
    if (showWorktree) {
      setExitFlow(
        <ExitFlow
          showWorktree
          onDone={() => {}}
          onCancel={() => {
            setExitFlow(null)
            setIsExiting(false)
          }}
        />,
      )
      return
    }
    const exitFlowResult = await exit.call(() => {})
    setExitFlow(exitFlowResult)
    if (exitFlowResult === null) {
      setIsExiting(false)
    }
  }, [])

  return {
    exitFlow,
    isExiting,
    handleExit,
  }
}
