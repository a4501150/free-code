import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
} from 'react'
import { useInput } from '../../ink.js'
import { useTerminalSize } from '../useTerminalSize.js'
import { useSearchHighlight } from '../../ink/hooks/use-search-highlight.js'
import {
  useUnseenDivider,
  computeUnseenDivider,
} from '../../components/FullscreenLayout.js'
import { useShowInjectedContext } from '../useShowInjectedContext.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'
import { openFileInExternalEditor } from '../../utils/editor.js'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Screen } from '../../types/repl.js'
import type { JumpHandle } from '../../components/VirtualMessageList.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { Message as MessageType } from '../../types/message.js'
import type { MessageActionsState } from '../../components/messageActions.js'
import type { StreamingToolUse } from '../../utils/messages.js'
import type { Tool } from '../../Tool.js'
const HISTORY_STUB = { maybeLoadOlder: (_: ScrollBoxHandle) => {} }
const RECENT_SCROLL_REPIN_WINDOW_MS = 3000

export function useReplTranscript({
  messages,
  deferredMessages,
  streamingToolUses,
  viewingAgentTaskId,
  tools,
}: {
  messages: MessageType[]
  deferredMessages: MessageType[]
  streamingToolUses: StreamingToolUse[]
  viewingAgentTaskId: string | undefined
  tools: readonly Tool[]
}) {
  const [screen, setScreen] = useState<Screen>('prompt')
  const [editorStatus, setEditorStatus] = useState('')
  const editorGenRef = useRef(0)
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const editorRenderingRef = useRef(false)

  const scrollRef = useRef<ScrollBoxHandle>(null)
  const modalScrollRef = useRef<ScrollBoxHandle>(null)
  const scrollKeyTargetRef = useMemo(
    () => ({
      get current(): ScrollBoxHandle | null {
        return modalScrollRef.current ?? scrollRef.current
      },
    }),
    [],
  )
  const lastUserScrollTsRef = useRef(0)

  const [cursor, setCursor] = useState<MessageActionsState | null>(null)
  const cursorNavRef = useRef(null)

  const {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider,
  } = useUnseenDivider(messages.length)

  const showInjectedContext = useShowInjectedContext()
  const unseenDivider = useMemo(
    () => computeUnseenDivider(messages, dividerIndex, showInjectedContext),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dividerIndex, messages.length, showInjectedContext],
  )

  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom()
    onRepin()
    setCursor(null)
  }, [onRepin, setCursor])

  // Re-pin when switching agent views
  const prevViewingAgentTaskIdRef = useRef(viewingAgentTaskId)
  useLayoutEffect(() => {
    if (prevViewingAgentTaskIdRef.current !== viewingAgentTaskId) repinScroll()
    prevViewingAgentTaskIdRef.current = viewingAgentTaskId
  }, [viewingAgentTaskId, repinScroll])

  // Backstop repin for human messages
  const lastMsg = messages.at(-1)
  const lastMsgIsHuman = lastMsg != null && isHumanTurn(lastMsg)
  useEffect(() => {
    if (lastMsgIsHuman) {
      repinScroll()
    }
  }, [lastMsgIsHuman, lastMsg, repinScroll])

  const { maybeLoadOlder } = HISTORY_STUB
  const composedOnScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      lastUserScrollTsRef.current = Date.now()
      if (sticky) {
        onRepin()
      } else {
        onScrollAway(handle)
      }
    },
    [onRepin, onScrollAway],
  )

  // Frozen state for transcript mode
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number
    streamingToolUsesLength: number
  } | null>(null)

  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length,
    })
  }, [messages.length, streamingToolUses.length])

  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null)
  }, [])

  const transcriptMessages = frozenTranscriptState
    ? deferredMessages.slice(0, frozenTranscriptState.messagesLength)
    : deferredMessages
  const transcriptStreamingToolUses = frozenTranscriptState
    ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength)
    : streamingToolUses

  // Search state
  const jumpRef = useRef<JumpHandle | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCount, setSearchCount] = useState(0)
  const [searchCurrent, setSearchCurrent] = useState(0)
  const onSearchMatchesChange = useCallback(
    (count: number, current: number) => {
      setSearchCount(count)
      setSearchCurrent(current)
    },
    [],
  )

  const {
    setQuery: setHighlight,
    scanElement,
    setPositions,
  } = useSearchHighlight()

  // Resize → abort search
  const transcriptCols = useTerminalSize().columns
  const prevColsRef = useRef(transcriptCols)
  useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols
      if (searchQuery || searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchCount(0)
        setSearchCurrent(0)
        jumpRef.current?.disarmSearch()
        setHighlight('')
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight])

  // Clear search on transcript exit
  const inTranscript = screen === 'transcript'
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('')
      setSearchCount(0)
      setSearchCurrent(0)
      setSearchOpen(false)
      editorGenRef.current++
      clearTimeout(editorTimerRef.current)
      setEditorStatus('')
    }
  }, [inTranscript])
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '')
    if (!inTranscript) setPositions(null)
  }, [inTranscript, searchQuery, setHighlight, setPositions])

  // Search mode keybinding (/ n N)
  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) return
      if (input === '/') {
        jumpRef.current?.setAnchor()
        setSearchOpen(true)
        event.stopImmediatePropagation()
        return
      }
      const c = input[0]
      if (
        (c === 'n' || c === 'N') &&
        input === c.repeat(input.length) &&
        searchCount > 0
      ) {
        const fn =
          c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch
        if (fn) for (let i = 0; i < input.length; i++) fn()
        event.stopImmediatePropagation()
      }
    },
    { isActive: screen === 'transcript' && !searchOpen },
  )

  // Transcript escape hatches: q exits, v opens editor
  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) return
      if (input === 'q') {
        handleExitTranscript()
        event.stopImmediatePropagation()
        return
      }
      if (input === 'v') {
        event.stopImmediatePropagation()
        if (editorRenderingRef.current) return
        editorRenderingRef.current = true
        const gen = editorGenRef.current
        const setStatus = (s: string): void => {
          if (gen !== editorGenRef.current) return
          clearTimeout(editorTimerRef.current)
          setEditorStatus(s)
        }
        setStatus(`rendering ${deferredMessages.length} messages…`)
        void (async () => {
          try {
            // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time
            const w = Math.max(80, (process.stdout.columns ?? 80) - 6)
            const raw = await renderMessagesToPlainText(
              deferredMessages,
              tools,
              w,
            )
            const text = raw.replace(/[ \t]+$/gm, '')
            const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`)
            await writeFile(path, text)
            const opened = openFileInExternalEditor(path)
            setStatus(
              opened
                ? `opening ${path}`
                : `wrote ${path} · no $VISUAL/$EDITOR set`,
            )
          } catch (e) {
            setStatus(
              `render failed: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
          editorRenderingRef.current = false
          if (gen !== editorGenRef.current) return
          editorTimerRef.current = setTimeout(s => s(''), 4000, setEditorStatus)
        })()
      }
    },
    { isActive: screen === 'transcript' && !searchOpen },
  )

  const globalKeybindingProps = {
    screen,
    setScreen,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    searchBarOpen: searchOpen,
  }

  return {
    screen,
    setScreen,
    editorStatus,
    setEditorStatus,
    editorGenRef,
    editorTimerRef,
    editorRenderingRef,
    scrollRef,
    modalScrollRef,
    scrollKeyTargetRef,
    lastUserScrollTsRef,
    cursor,
    setCursor,
    cursorNavRef,
    dividerYRef,
    jumpToNew,
    shiftDivider,
    unseenDivider,
    repinScroll,
    composedOnScroll,
    frozenTranscriptState,
    handleEnterTranscript,
    handleExitTranscript,
    transcriptMessages,
    transcriptStreamingToolUses,
    jumpRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchCount,
    setSearchCount,
    searchCurrent,
    setSearchCurrent,
    onSearchMatchesChange,
    setHighlight,
    scanElement,
    setPositions,
    globalKeybindingProps,
    showInjectedContext,
    RECENT_SCROLL_REPIN_WINDOW_MS,
  }
}
