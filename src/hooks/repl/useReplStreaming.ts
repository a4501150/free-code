import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { count } from '../../utils/array.js'
import { truncateToWidth } from '../../utils/format.js'
import { hasCursorUpViewportYankBug } from '../../ink/terminal.js'
import { endInteractionSpan } from '../../utils/telemetry/sessionTracing.js'
import { SLEEP_TOOL_NAME } from '../../tools/SleepTool/prompt.js'
import { extractBashToolsFromMessages } from '../../utils/queryHelpers.js'
import { getTipToShowOnSpinner } from '../../services/tips/tipScheduler.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type {
  StreamingToolUse,
  StreamingThinking,
} from '../../utils/messages.js'
import type {
  Message as MessageType,
  ProgressMessage,
} from '../../types/message.js'
import type { HookProgress } from '../../types/hooks.js'
import type { ThemeName, Theme } from '../../utils/theme.js'

export function useReplStreaming({
  messagesRef,
  messages,
  inProgressToolUseIDs,
  setAppState,
  theme,
  reducedMotion,
  bashTools,
  bashToolsProcessedIdx,
  readFileState,
}: {
  messagesRef: React.RefObject<MessageType[]>
  messages: MessageType[]
  inProgressToolUseIDs: Set<string>
  setAppState: (fn: (prev: any) => any) => void
  theme: ThemeName
  reducedMotion: boolean
  bashTools: React.RefObject<Set<string>>
  bashToolsProcessedIdx: React.RefObject<number>
  readFileState: React.RefObject<any>
}) {
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding')
  const streamModeRef = useRef(streamMode)
  streamModeRef.current = streamMode

  const [streamingToolUses, setStreamingToolUses] = useState<
    StreamingToolUse[]
  >([])
  const [streamingThinking, setStreamingThinking] =
    useState<StreamingThinking | null>(null)

  // Auto-hide streaming thinking after 30 seconds of being completed
  useEffect(() => {
    if (
      streamingThinking &&
      !streamingThinking.isStreaming &&
      streamingThinking.streamingEndedAt
    ) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt
      const remaining = 30000 - elapsed
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null)
        return () => clearTimeout(timer)
      } else {
        setStreamingThinking(null)
      }
    }
  }, [streamingThinking])

  const [streamingText, setStreamingText] = useState<string | null>(null)
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug()
  const onStreamingText = useCallback(
    (f: (current: string | null) => string | null) => {
      if (!showStreamingText) return
      setStreamingText(f)
    },
    [showStreamingText],
  )

  const visibleStreamingText =
    streamingText && showStreamingText
      ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
      : null

  const responseLengthRef = useRef(0)
  const setResponseLength = useCallback((f: (prev: number) => number) => {
    responseLengthRef.current = f(responseLengthRef.current)
  }, [])

  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null)
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null)
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<
    keyof Theme | null
  >(null)
  const [compactingStartTime, setCompactingStartTime] = useState<number | null>(
    null,
  )

  const [hasInterruptibleToolInProgressRef] = useState(() => ({
    current: false,
  }))

  // Spinner tip
  const tipPickedThisTurnRef = useRef(false)
  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) return
    tipPickedThisTurnRef.current = true
    const newMessages = messagesRef.current.slice(bashToolsProcessedIdx.current)
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashTools.current.add(tool)
    }
    bashToolsProcessedIdx.current = messagesRef.current.length
    void getTipToShowOnSpinner({
      readFileState: readFileState.current,
      bashTools: bashTools.current,
    }).then(async tip => {
      if (tip) {
        const content = await tip.content({ theme })
        setAppState(prev => ({
          ...prev,
          spinnerTip: content,
        }))
      } else {
        setAppState(prev => {
          if (prev.spinnerTip === undefined) return prev
          return { ...prev, spinnerTip: undefined }
        })
      }
    })
  }, [
    setAppState,
    theme,
    messagesRef,
    bashTools,
    bashToolsProcessedIdx,
    readFileState,
  ])

  const resetStreamingState = useCallback(() => {
    setStreamingToolUses([])
    setStreamingText(null)
    responseLengthRef.current = 0
    setSpinnerMessage(null)
    setSpinnerColor(null)
    setSpinnerShimmerColor(null)
    setCompactingStartTime(null)
    pickNewSpinnerTip()
    endInteractionSpan()
  }, [pickNewSpinnerTip])

  // Hide spinner when the only in-progress tool is Sleep
  const onlySleepToolActive = useMemo(() => {
    const lastAssistant = messages.findLast(m => m.type === 'assistant')
    if (lastAssistant?.type !== 'assistant') return false
    const inProgressTools = lastAssistant.message.content.filter(
      b => b.type === 'tool_use' && inProgressToolUseIDs.has(b.id),
    )
    return (
      inProgressTools.length > 0 &&
      inProgressTools.every(
        b => b.type === 'tool_use' && b.name === SLEEP_TOOL_NAME,
      )
    )
  }, [messages, inProgressToolUseIDs])

  // Stop hook spinner suffix
  const stopHookSpinnerSuffix = useMemo(() => {
    const progressMsgs = messages.filter(
      (m): m is ProgressMessage<HookProgress> =>
        m.type === 'progress' &&
        m.data.type === 'hook_progress' &&
        (m.data.hookEvent === 'Stop' || m.data.hookEvent === 'SubagentStop'),
    )
    if (progressMsgs.length === 0) return null

    const currentToolUseID = progressMsgs.at(-1)?.toolUseID
    if (!currentToolUseID) return null

    const hasSummaryForCurrentExecution = messages.some(
      m =>
        m.type === 'system' &&
        m.subtype === 'stop_hook_summary' &&
        m.toolUseID === currentToolUseID,
    )
    if (hasSummaryForCurrentExecution) return null

    const currentHooks = progressMsgs.filter(
      p => p.toolUseID === currentToolUseID,
    )
    const total = currentHooks.length

    const completedCount = count(messages, m => {
      if (m.type !== 'attachment') return false
      const attachment = m.attachment
      return (
        'hookEvent' in attachment &&
        (attachment.hookEvent === 'Stop' ||
          attachment.hookEvent === 'SubagentStop') &&
        'toolUseID' in attachment &&
        attachment.toolUseID === currentToolUseID
      )
    })

    const customMessage = currentHooks.find(p => p.data.statusMessage)?.data
      .statusMessage

    if (customMessage) {
      return total === 1
        ? `${customMessage}…`
        : `${customMessage}… ${completedCount}/${total}`
    }

    const hookType =
      currentHooks[0]?.data.hookEvent === 'SubagentStop'
        ? 'subagent stop'
        : 'stop'

    const cmd = currentHooks[completedCount]?.data.command
    const label = cmd ? ` '${truncateToWidth(cmd, 40)}'` : ''
    return total === 1
      ? `running ${hookType} hook${label}`
      : `running ${hookType} hook${label}\u2026 ${completedCount}/${total}`
  }, [messages])

  return {
    streamMode,
    setStreamMode,
    streamModeRef,
    streamingToolUses,
    setStreamingToolUses,
    streamingThinking,
    setStreamingThinking,
    streamingText,
    setStreamingText,
    onStreamingText,
    visibleStreamingText,
    showStreamingText,
    responseLengthRef,
    setResponseLength,
    spinnerMessage,
    setSpinnerMessage,
    spinnerColor,
    setSpinnerColor,
    spinnerShimmerColor,
    setSpinnerShimmerColor,
    compactingStartTime,
    setCompactingStartTime,
    hasInterruptibleToolInProgressRef,
    tipPickedThisTurnRef,
    resetStreamingState,
    onlySleepToolActive,
    stopHookSpinnerSuffix,
  }
}
