import { useMemo, useRef, useState } from 'react'
import type { WireCatalog, WirePendingCommand } from '../../../session/wire.js'
import {
  composerPlaceholder,
  queueEditBody,
  queueRemoveBody,
  queueRows,
  slashSuggestions,
  submitIntent,
  type PaletteItem,
} from '../composerViews.js'
import {
  imageFilesFrom,
  prepareImage,
  type PendingImage,
} from '../imageUpload.js'

/** Mirrors `MAX_PROMPT_IMAGES`, which the host enforces. */
const MAX_IMAGES = 4

/** Narrower than a plain string, so it satisfies `WireImage`'s media enum. */
export type SubmitImage = {
  mediaType: PendingImage['mediaType']
  data: string
}

/**
 * The prompt editor.
 *
 * A slash palette over the session's command catalog (descriptions and arg
 * hints included — the catalog carries them since v2) and `@` file mentions.
 * The file list comes from what the transcript has already touched: the
 * browser has no filesystem access, and asking the session to walk the tree
 * on every keystroke would be a poor trade for a phone on a tunnel.
 *
 * While a turn runs, send keeps queueing and `steer` (or Shift+Enter)
 * interrupts — two distinct affordances, because both must be safe to press
 * by thumb. Below the field, the session queue is addressable: each queued
 * prompt can be fixed or dropped, not just watched.
 */
export function Composer({
  busy,
  knownPaths,
  commands,
  queued,
  onRpc,
  onSubmit,
  onInterrupt,
}: {
  busy: boolean
  knownPaths: string[]
  /** `catalog.commands`, descriptions and arg hints included. */
  commands: WireCatalog['commands']
  /** `view.queue` — the session's pending prompts. */
  queued: WirePendingCommand[]
  /** Sends `{kind:'rpc', ...}`; the bodies come from composerViews. */
  onRpc(body: unknown): void
  onSubmit(
    text: string,
    delivery: 'next' | 'interrupt',
    images: SubmitImage[],
  ): void
  onInterrupt(): void
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const [images, setImages] = useState<PendingImage[]>([])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const token = useMemo(() => {
    const match = /(^\/[^\s]*)$|(@[^\s]*)$/i.exec(value)
    return match ? (match[1] ?? match[2] ?? '') : ''
  }, [value])

  const suggestions = useMemo<PaletteItem[]>(() => {
    if (token.startsWith('/')) return slashSuggestions(commands, token)
    if (token.startsWith('@')) {
      const needle = token.slice(1).toLowerCase()
      return knownPaths
        .filter(path => path.toLowerCase().includes(needle))
        .slice(0, 8)
        .map(path => ({ value: `@${path}` }))
    }
    return []
  }, [token, knownPaths, commands])

  function accept(suggestion: PaletteItem): void {
    // A command with an arg hint lands with a trailing space and the caret
    // after it, which is where the arguments go. Submission of the bare
    // text is fine too: the core parses slash commands.
    setValue(
      value.slice(0, value.length - token.length) + suggestion.value + ' ',
    )
    setSelected(0)
    inputRef.current?.focus()
  }

  async function addFiles(files: File[]): Promise<void> {
    if (!files.length) return
    setError('')
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      setError(`${MAX_IMAGES} images is the limit`)
      return
    }
    for (const file of files.slice(0, room)) {
      try {
        const image = await prepareImage(file)
        setImages(current => [...current, image])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    if (files.length > room) setError(`${MAX_IMAGES} images is the limit`)
  }

  function removeImage(id: string): void {
    setImages(current => {
      const image = current.find(candidate => candidate.id === id)
      if (image) URL.revokeObjectURL(image.previewUrl)
      return current.filter(candidate => candidate.id !== id)
    })
  }

  function submit(delivery: 'next' | 'interrupt'): void {
    const text = value.trim()
    if (!text && !images.length) return
    onSubmit(
      text,
      delivery,
      images.map(image => ({ mediaType: image.mediaType, data: image.data })),
    )
    for (const image of images) URL.revokeObjectURL(image.previewUrl)
    setImages([])
    setValue('')
    setSelected(0)
    setError('')
  }

  const canSend = Boolean(value.trim()) || images.length > 0
  const rows = queueRows(queued)

  return (
    <div className="composer">
      {suggestions.length ? (
        <ul className="composer__suggestions">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.value}>
              <button
                type="button"
                className={index === selected ? 'is-selected' : ''}
                onMouseDown={event => {
                  event.preventDefault()
                  accept(suggestion)
                }}
              >
                <span className="composer__suggestion-name">
                  {suggestion.value}
                </span>
                {suggestion.hint ? (
                  <span className="composer__suggestion-hint">
                    {suggestion.hint}
                  </span>
                ) : null}
                {suggestion.detail ? (
                  <span className="composer__suggestion-detail">
                    {suggestion.detail}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {images.length ? (
        <ul className="composer__attachments">
          {images.map(image => (
            <li key={image.id} className="attachment">
              <img src={image.previewUrl} alt={image.name} />
              <button
                type="button"
                className="attachment__remove"
                aria-label={`Remove ${image.name}`}
                onClick={() => removeImage(image.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="composer__error">{error}</p> : null}

      <div className="composer__row">
        <textarea
          ref={inputRef}
          className="composer__input"
          value={value}
          rows={1}
          placeholder={composerPlaceholder(busy)}
          onChange={event => setValue(event.target.value)}
          onPaste={event => {
            const files = imageFilesFrom(event.clipboardData.items)
            if (!files.length) return
            event.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={event => {
            if (suggestions.length) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected(s => (s + 1) % suggestions.length)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected(
                  s => (s - 1 + suggestions.length) % suggestions.length,
                )
                return
              }
              if (event.key === 'Tab' || (event.key === 'Enter' && token)) {
                event.preventDefault()
                accept(suggestions[selected]!)
                return
              }
            }
            const intent = submitIntent({
              key: event.key,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              busy,
            })
            if (intent === 'none' || intent === 'newline') return
            event.preventDefault()
            submit(intent)
          }}
        />
      </div>

      <div className="composer__actions">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="composer__file"
          onChange={event => {
            void addFiles(imageFilesFrom(event.target.files ?? []))
            // Lets the same file be picked twice in a row.
            event.target.value = ''
          }}
        />
        <button
          type="button"
          className="btn btn--attach"
          onClick={() => fileRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
        >
          + image
        </button>
        <span className="composer__spacer" />
        {/* Send always queues; steer interrupts the running turn and runs
            this prompt next; stop ends the turn without a follow-up. The
            three differ exactly when a turn is in flight, which is when the
            wrong press is expensive — so they are three buttons. */}
        <button
          type="button"
          className="btn btn--send"
          onClick={() => submit('next')}
          disabled={!canSend}
        >
          send
        </button>
        {busy ? (
          <button
            type="button"
            className="btn btn--steer"
            onClick={() => submit('interrupt')}
            disabled={!canSend}
          >
            steer
          </button>
        ) : null}
        {busy ? (
          <button type="button" className="btn btn--stop" onClick={onInterrupt}>
            stop
          </button>
        ) : null}
      </div>

      {rows.length ? (
        <ul className="queued" aria-label="Queued prompts">
          {rows.map(row => (
            <QueuedRow key={row.id} row={row} onRpc={onRpc} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * One queued prompt: text, and the two edits the session can apply to it.
 * The draft is local; the row itself comes and goes with `queue` events, so
 * an edit that lands simply re-renders with the new text.
 */
function QueuedRow({
  row,
  onRpc,
}: {
  row: WirePendingCommand
  onRpc(body: unknown): void
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.text)

  function commit(): void {
    setEditing(false)
    const text = draft.trim()
    if (text && text !== row.text) onRpc(queueEditBody(row.id, text))
    else setDraft(row.text)
  }

  return (
    <li className="queued__row">
      <span className="queued__gutter">›</span>
      {editing ? (
        <input
          className="queued__edit"
          value={draft}
          autoFocus
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              setEditing(false)
              setDraft(row.text)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="queued__text"
          title="Edit queued prompt"
          onClick={() => {
            setDraft(row.text)
            setEditing(true)
          }}
        >
          {row.text}
        </button>
      )}
      <button
        type="button"
        className="queued__remove"
        aria-label="Remove queued prompt"
        onClick={() => onRpc(queueRemoveBody(row.id))}
      >
        ×
      </button>
    </li>
  )
}
