import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebSlashCommand } from '../../protocol/attachSchemas.js'
import {
  imageFilesFrom,
  prepareImage,
  type PendingImage,
} from '../imageUpload.js'

/** Mirrors `MAX_SUBMIT_IMAGES`, which the host enforces. */
const MAX_IMAGES = 4

type Suggestion = { value: string; hint?: string }

/**
 * The completion token the caret sits in, or '' — matched against the text
 * before the caret, so a token anywhere in the message (with the caret on
 * it) completes. A `/` or `@` only opens completion at a word boundary:
 * paths like `src/utils` and emails like `a@b` are not tokens.
 */
export function completionToken(value: string, cursor: number): string {
  const match = /(?:^|\s)(\/[^\s]*)$|(?:^|\s)(@[^\s]*)$/i.exec(
    value.slice(0, cursor),
  )
  return match ? (match[1] ?? match[2] ?? '') : ''
}

/** Narrower than a plain string, so it satisfies the protocol's media enum. */
export type SubmitImage = {
  mediaType: PendingImage['mediaType']
  data: string
}

/**
 * The prompt editor.
 *
 * Autocomplete for slash commands and `@` file mentions, triggered wherever
 * the caret sits inside such a token — a command named mid-sentence completes
 * just like one at the start. A slash only opens completion at a word
 * boundary (start of input or after whitespace), so paths like `src/utils`
 * never trigger it. The file list comes from what the transcript has already
 * touched: the browser has no filesystem access, and asking the session to
 * walk the tree on every keystroke would be a poor trade for a phone on a
 * tunnel.
 */
export function Composer({
  busy,
  knownPaths,
  commands,
  onSubmit,
  onInterrupt,
}: {
  busy: boolean
  knownPaths: string[]
  commands: WebSlashCommand[]
  onSubmit(
    text: string,
    delivery: 'next' | 'interrupt',
    images: SubmitImage[],
  ): void
  onInterrupt(): void
}): React.ReactElement {
  const [value, setValue] = useState('')
  // The caret, not the end of the input, decides where the token is: the
  // user may complete mid-message or move the caret back before typing.
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)
  const [images, setImages] = useState<PendingImage[]>([])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // The caret a completed token should land on, applied after React pushes
  // the new value (setSelectionRange against the old value snaps back).
  const pendingSelection = useRef<number | null>(null)

  const token = useMemo(() => completionToken(value, cursor), [value, cursor])

  const suggestions = useMemo<Suggestion[]>(() => {
    if (token.startsWith('/')) {
      const query = token.toLowerCase()
      return commands
        .filter(c => `/${c.name}`.toLowerCase().startsWith(query))
        .slice(0, 12)
        .map(command => ({
          value: `/${command.name}`,
          hint: command.description,
        }))
    }
    if (token.startsWith('@')) {
      const needle = token.slice(1).toLowerCase()
      return knownPaths
        .filter(path => path.toLowerCase().includes(needle))
        .slice(0, 8)
        .map(path => ({ value: `@${path}` }))
    }
    return []
  }, [token, knownPaths, commands])

  useEffect(() => {
    if (pendingSelection.current !== null && inputRef.current) {
      const pos = pendingSelection.current
      pendingSelection.current = null
      inputRef.current.setSelectionRange(pos, pos)
    }
  }, [value])

  function accept(suggestion: Suggestion): void {
    const start = cursor - token.length
    pendingSelection.current = start + suggestion.value.length + 1
    setValue(
      value.slice(0, start) + suggestion.value + ' ' + value.slice(cursor),
    )
    setCursor(pendingSelection.current)
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
    setCursor(0)
    setSelected(0)
    setError('')
  }

  const canSend = Boolean(value.trim()) || images.length > 0

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
          placeholder="Message, or / for a command"
          onChange={event => {
            setValue(event.target.value)
            setCursor(event.target.selectionStart ?? event.target.value.length)
          }}
          onSelect={event => setCursor(event.currentTarget.selectionStart)}
          onClick={event => setCursor(event.currentTarget.selectionStart)}
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
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              // Shift+Enter is a newline, as it is in every other chat input.
              // Steering and stopping are the two buttons below.
              if (event.altKey || event.shiftKey) return
              event.preventDefault()
              submit('next')
            }
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
        {/* Send always queues. Stop is the only thing that ends a running
            turn, which is what makes both safe to press by thumb. */}
        <button
          type="button"
          className="btn btn--send"
          onClick={() => submit('next')}
          disabled={!canSend}
        >
          send
        </button>
        {busy ? (
          <button type="button" className="btn btn--stop" onClick={onInterrupt}>
            stop
          </button>
        ) : null}
      </div>
    </div>
  )
}
