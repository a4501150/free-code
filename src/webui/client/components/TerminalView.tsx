import { useEffect, useRef, useState } from 'react'
import type { WebTaskSummary } from '../../protocol/attachSchemas.js'
import type { ShellOutputState } from './TaskOutputView.js'

/**
 * The browser terminal for an interactive (PTY-backed) task — the web twin
 * of the TUI's interactive bash view, but with a real terminal emulator so
 * full-screen apps render too. xterm.js is lazy-loaded from a pinned
 * jsdelivr URL (same trust boundary and CSP allowance as KaTeX/mermaid; a
 * static import would blow the embedded bundle budget).
 */
export const XTERM_VERSION = '5.5.0'
export const XTERM_ADDON_FIT_VERSION = '0.10.0'

// Full literal URLs (not template literals) and typed `string` (not a
// literal) so the bundler keeps `import()` as a runtime fetch instead of
// inlining the module — and the built artifact contains the complete
// pinned URLs the bundle guard asserts (mathRender.ts precedent).
const XTERM_MODULE_URL: string =
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm'
const XTERM_FIT_MODULE_URL: string =
  'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm'
const XTERM_CSS_URL: string =
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css'

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || document.querySelector(`link[href="${XTERM_CSS_URL}"]`)) {
    cssInjected = true
    return
  }
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = XTERM_CSS_URL
  document.head.appendChild(link)
  cssInjected = true
}

type AnyTerminal = {
  write(data: string): void
  dispose(): void
  focus(): void
  onData(cb: (data: string) => void): void
  onResize(cb: (e: { cols: number; rows: number }) => void): void
  loadAddon(addon: unknown): void
  open(el: HTMLElement): void
}

/**
 * Keys a phone keyboard cannot produce (or produces only through three
 * long-press menus), sent straight to the PTY. `onMouseDown` preventDefault
 * keeps focus in the terminal so the soft keyboard stays open between taps.
 */
const KEY_ROW: { label: string; seq: string; name: string }[] = [
  { label: 'esc', seq: '\x1b', name: 'Escape' },
  { label: '^C', seq: '\x03', name: 'Ctrl-C' },
  { label: '^D', seq: '\x04', name: 'Ctrl-D' },
  { label: 'tab', seq: '\t', name: 'Tab' },
  { label: '←', seq: '\x1b[D', name: 'Left' },
  { label: '↑', seq: '\x1b[A', name: 'Up' },
  { label: '↓', seq: '\x1b[B', name: 'Down' },
  { label: '→', seq: '\x1b[C', name: 'Right' },
  { label: '|', seq: '|', name: 'Pipe' },
]

type FitAddonLike = { fit(): void }

export function TerminalView({
  taskId,
  task,
  state,
  onInput,
  onResize,
  onKillTask,
}: {
  taskId: string
  task: WebTaskSummary | undefined
  /** Accumulated raw PTY bytes: the subscribe-from-zero replay plus appends. */
  state: ShellOutputState
  /** Bytes typed into the browser terminal; never persisted. */
  onInput(data: string): void
  onResize(cols: number, rows: number): void
  onKillTask(taskId: string): void
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<AnyTerminal | null>(null)
  const fitRef = useRef<FitAddonLike | null>(null)
  // How many bytes of state.text have been written into xterm already.
  const writtenRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  // The mount effect below runs once per task; keep the latest callbacks
  // reachable from it without re-running on identity changes.
  const callbacksRef = useRef({ onInput, onResize })
  callbacksRef.current = { onInput, onResize }

  // Mount xterm once per viewed task. The append-feed effect below is
  // driven by [state.text] deltas and picks up the terminal via termRef.
  useEffect(() => {
    let disposed = false
    ;(async () => {
      const [{ Terminal }, { FitAddon }] = (await Promise.all([
        import(XTERM_MODULE_URL),
        import(XTERM_FIT_MODULE_URL),
      ])) as [
        { Terminal: new (opts: unknown) => AnyTerminal },
        { FitAddon: new () => FitAddonLike },
      ]
      if (disposed || !containerRef.current) return
      ensureCss()
      const term = new Terminal({
        fontSize: 13,
        scrollback: 10_000,
        convertEol: false,
        theme: { background: '#0b0d0f' },
        // A phone user taps to focus and cannot tell an unfocused
        // (invisible-cursor-by-default) terminal from a dead one.
        cursorBlink: true,
        cursorInactiveStyle: 'outline',
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(containerRef.current)
      fit.fit()
      term.onData(data => callbacksRef.current.onInput(data))
      term.onResize(({ cols, rows }) =>
        callbacksRef.current.onResize(cols, rows),
      )
      termRef.current = term
      fitRef.current = fit
      writtenRef.current = 0
      setReady(true)
    })().catch(err => {
      if (!disposed) setFailed(String(err))
    })
    return () => {
      disposed = true
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  useEffect(() => {
    if (!ready || !containerRef.current) return
    const observer = new ResizeObserver(() => fitRef.current?.fit())
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [ready])

  // Feed raw byte deltas into the emulator. A shrunk state.text means the
  // viewer re-seeded (re-opened the same task): replay from zero.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (state.text.length < writtenRef.current) writtenRef.current = 0
    if (state.text.length > writtenRef.current) {
      term.write(state.text.slice(writtenRef.current))
      writtenRef.current = state.text.length
    }
  }, [state.text, ready])

  const stoppable = !state.done && !state.gone

  return (
    <div className="shellout">
      <header className="shellout__head">
        {task?.command ? (
          <pre className="shellout__command">{task.command}</pre>
        ) : null}
        <div className="shellout__meta">
          <span className={`task__status is-${task?.status ?? 'unknown'}`}>
            {task?.status ?? 'gone'}
          </span>
          {task?.exitCode !== undefined ? (
            <span
              className={`shellout__exit${task.exitCode === 0 ? ' is-clean' : ''}`}
            >
              exit {task.exitCode}
            </span>
          ) : null}
          {stoppable ? (
            <button
              type="button"
              className="task__kill"
              aria-label="Stop task"
              title="Stop"
              onClick={() => onKillTask(taskId)}
            >
              ■ stop
            </button>
          ) : null}
        </div>
      </header>
      {failed ? (
        <div className="viewer__error">
          Terminal failed to load from the pinned CDN: {failed}
        </div>
      ) : (
        <>
          <div className="shellout__termwrap">
            <div
              ref={containerRef}
              className="shellout__term"
              // Taps anywhere in the box route the keyboard to the PTY;
              // the hint (hidden by :focus-within in CSS) tells the reader
              // the box is waiting for them.
              onClick={() => termRef.current?.focus()}
            />
            <div className="shellout__hint" aria-hidden="true">
              ▸ tap terminal to type
            </div>
          </div>
          <div className="shellout__keys">
            {KEY_ROW.map(key => (
              <button
                key={key.name}
                type="button"
                className="shellout__key"
                aria-label={key.name}
                title={key.name}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  termRef.current?.focus()
                  onInput(key.seq)
                }}
              >
                {key.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
