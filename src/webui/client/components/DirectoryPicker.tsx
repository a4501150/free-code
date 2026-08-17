import { useEffect, useRef, useState } from 'react'
import { fetchDirectories } from '../api.js'
import type { DirectoryListing } from '../../gateway/directories.js'

const DEBOUNCE_MS = 180

/** The path to type to browse into `path`. */
export function intoDirectory(path: string): string {
  return path.endsWith('/') || path.endsWith('\\') ? path : path + '/'
}

type Row = { label: string; path: string; note: string }

function rowsOf(listing: DirectoryListing | null): Row[] {
  if (!listing) return []
  const parent: Row[] = listing.parent
    ? [{ label: '..', path: listing.parent, note: 'up' }]
    : []
  return [
    ...parent,
    ...listing.entries.map(entry => ({
      label: entry.name,
      path: entry.path,
      note: '',
    })),
  ]
}

/**
 * The host filesystem, one directory at a time.
 *
 * The browser cannot read a disk, so every row comes from the gateway. A click
 * writes the row's absolute path back into the field, which lists that
 * directory in turn, so repeated clicks walk down the tree.
 *
 * Nothing is selected when a listing arrives. Enter has to keep starting the
 * session for someone who typed a path and never looked at the list.
 */
export function DirectoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange(next: string): void
  disabled: boolean
}): React.ReactElement {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(true)
  const [selected, setSelected] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const adopted = useRef(false)
  const caretToEnd = useRef(false)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setSelected(-1)
    setLoading(true)
    const timer = setTimeout(() => {
      void fetchDirectories(value, showHidden, controller.signal)
        .then(result => {
          // The cleanup already ran, so this answer describes a path the field
          // no longer holds.
          if (!live) return
          setLoading(false)
          if (result.ok) {
            setListing(result.listing)
            setError('')
          } else {
            setListing(null)
            setError(result.error)
          }
        })
        .catch(() => {
          // An abort is the expected end of a superseded request.
          if (live) setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      live = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [value, showHidden])

  // With an empty field the gateway falls back to the home directory. Adopt it
  // once, so the field names the directory the rows came from. Only once: a
  // field the user clears on purpose must stay clear for them to type into.
  useEffect(() => {
    if (adopted.current || !listing || value.trim()) return
    adopted.current = true
    onChange(intoDirectory(listing.base))
  }, [value, listing, onChange])

  // The rows are replaced in place, and the browser keeps the old offset. It
  // would hide the ".." row on the way into a long directory.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [listing])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // After a row is taken, not during: the field still holds the old path until
  // React re-renders. A path outgrows the rail quickly, and the tail is the end
  // that just changed, so show that end. Moving the caret alone does not scroll
  // a field whose value was replaced under an already-focused element.
  useEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const input = inputRef.current
    if (!input) return
    input.setSelectionRange(input.value.length, input.value.length)
    input.scrollLeft = input.scrollWidth
  }, [value])

  const rows = rowsOf(listing)
  const firstEntry = listing?.parent ? 1 : 0
  const hasEntries = (listing?.entries.length ?? 0) > 0

  function accept(row: Row): void {
    onChange(intoDirectory(row.path))
    inputRef.current?.focus()
    caretToEnd.current = true
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (!rows.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(current => Math.min(current + 1, rows.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(current => (current <= 0 ? -1 : current - 1))
      return
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      // Completing the first real name, the way a shell would. The parent row
      // is never what Tab means.
      const row =
        selected >= 0 ? rows[selected] : hasEntries && rows[firstEntry]
      if (!row) return
      event.preventDefault()
      accept(row)
      return
    }
    if (event.key === 'Enter' && selected >= 0) {
      event.preventDefault()
      accept(rows[selected]!)
      return
    }
    if (event.key === 'Escape' && selected >= 0) {
      event.preventDefault()
      setSelected(-1)
    }
  }

  const status = error
    ? error
    : loading
      ? 'reading…'
      : listing?.truncated
        ? 'too many to show. Type more of the name.'
        : listing && !hasEntries
          ? 'nothing to open in here'
          : ''

  return (
    <div className="rail__browse">
      <input
        ref={inputRef}
        className="rail__cwd"
        value={value}
        autoFocus
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-label="Working directory"
        placeholder="/path/on/the/host"
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />

      {rows.length ? (
        <ul className="rail__dirs" ref={listRef}>
          {rows.map((row, index) => (
            <li key={row.path}>
              <button
                ref={index === selected ? selectedRef : null}
                type="button"
                className={index === selected ? 'is-selected' : ''}
                onMouseDown={event => {
                  // Without this the field blurs first and the caret is lost.
                  event.preventDefault()
                  accept(row)
                }}
              >
                <span className="rail__dirname">{row.label}</span>
                <span className="rail__dirnote">{row.note || '/'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="rail__browsefoot">
        <button
          type="button"
          className="rail__toggle"
          aria-pressed={showHidden}
          onClick={() => setShowHidden(current => !current)}
        >
          [{showHidden ? 'x' : ' '}] hidden
        </button>
        {status ? (
          <span
            className={[
              error ? 'rail__error' : 'rail__hint',
              loading && !error ? 'is-busy' : '',
            ].join(' ')}
          >
            {status}
          </span>
        ) : null}
      </div>
    </div>
  )
}
