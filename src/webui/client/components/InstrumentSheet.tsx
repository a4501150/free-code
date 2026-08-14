import { useEffect, useRef, useState } from 'react'
import type { WebSessionMeta, WebTodo } from '../../protocol/attachSchemas.js'

/** Never let a drag eat the whole screen, or the transcript disappears. */
const MAX_FRACTION = 0.8
/** Below this the release snaps shut rather than open. */
const SNAP_PX = 96
/** A pointer that moves less than this was a tap, not a drag. */
const SLOP_PX = 6

function clampHeight(px: number): number {
  return Math.max(0, Math.min(px, window.innerHeight * MAX_FRACTION))
}

/**
 * Hosts the instrument panels.
 *
 * On a phone this is a sheet above the composer, because the instrument column
 * does not fit and hiding it altogether cost the model selector, the permission
 * modes and the todo list. On a wide screen the same DOM becomes the right-hand
 * column and the handle disappears, so there is only ever one instrument tree
 * and one set of controls.
 *
 * It stays in normal grid flow. A fixed sheet would have to track the
 * composer's changing height and fight the phone keyboard.
 */
export function InstrumentSheet({
  meta,
  todos,
  open,
  onToggle,
  children,
}: {
  meta: WebSessionMeta | null
  todos: WebTodo[]
  open: boolean
  onToggle(next: boolean): void
  children: React.ReactNode
}): React.ReactElement {
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [openHeight, setOpenHeight] = useState<number | null>(null)
  const start = useRef({ y: 0, height: 0 })
  const moved = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // A height chosen in portrait is wrong after a rotation.
  useEffect(() => {
    const onResize = (): void => {
      setOpenHeight(current => (current === null ? null : clampHeight(current)))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    start.current = {
      y: event.clientY,
      height: open ? (bodyRef.current?.offsetHeight ?? 0) : 0,
    }
    moved.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    // Dragging up grows the sheet.
    const delta = start.current.y - event.clientY
    if (Math.abs(delta) > SLOP_PX) moved.current = true
    if (!moved.current) return
    setDragHeight(clampHeight(start.current.height + delta))
  }

  function endDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const height = dragHeight
    setDragHeight(null)
    // A tap leaves the click handler to do the toggling.
    if (!moved.current || height === null) return
    if (height >= SNAP_PX) {
      setOpenHeight(height)
      onToggle(true)
    } else {
      onToggle(false)
    }
  }

  function onClick(): void {
    // Swallow the click that follows a real drag.
    if (moved.current) {
      moved.current = false
      return
    }
    if (!open) blurComposer()
    onToggle(!open)
  }

  const openTodos = todos.filter(t => t.status !== 'completed').length
  const dragging = dragHeight !== null

  return (
    <section
      className={`sheet ${open ? 'is-open' : ''} ${dragging ? 'is-dragging' : ''}`}
      style={
        openHeight === null
          ? undefined
          : ({ '--sheet-h': `${openHeight}px` } as React.CSSProperties)
      }
    >
      <button
        type="button"
        className="sheet__handle"
        aria-expanded={open}
        aria-controls="instrument-body"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onClick}
      >
        <span className="sheet__grip" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
        <span className="sheet__label">session details</span>
        <span className="sheet__summary">
          {meta ? (
            <>
              <span className={`sheet__glyph is-${meta.state}`}>●</span>
              <span>{meta.permissionMode ?? 'default'}</span>
              <span>${(meta.costUsd ?? 0).toFixed(3)}</span>
            </>
          ) : null}
          {openTodos ? <span className="sheet__todos">{openTodos}</span> : null}
        </span>
      </button>

      <div
        className="sheet__body"
        id="instrument-body"
        ref={bodyRef}
        style={dragging ? { height: `${dragHeight}px` } : undefined}
      >
        {children}
      </div>
    </section>
  )
}

/** The phone keyboard would otherwise cover the sheet that just opened. */
function blurComposer(): void {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement) active.blur()
}
