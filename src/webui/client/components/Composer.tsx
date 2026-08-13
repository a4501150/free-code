import { useMemo, useRef, useState } from 'react'

/** Slash commands the process executes. The gateway never interprets these. */
const COMMANDS = [
  '/clear',
  '/compact',
  '/config',
  '/context',
  '/cost',
  '/help',
  '/model',
  '/resume',
  '/status',
  '/tasks',
  '/todos',
]

type Suggestion = { value: string; hint?: string }

/**
 * The prompt editor.
 *
 * Autocomplete for slash commands and `@` file mentions. The file list comes
 * from what the transcript has already touched: the browser has no filesystem
 * access, and asking the session to walk the tree on every keystroke would be a
 * poor trade for a phone on a tunnel.
 */
export function Composer({
  busy,
  knownPaths,
  onSubmit,
  onInterrupt,
}: {
  busy: boolean
  knownPaths: string[]
  onSubmit(text: string, delivery: 'next' | 'interrupt'): void
  onInterrupt(): void
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const token = useMemo(() => {
    const match = /(^\/[a-z-]*)$|(@[^\s]*)$/i.exec(value)
    return match ? (match[1] ?? match[2] ?? '') : ''
  }, [value])

  const suggestions = useMemo<Suggestion[]>(() => {
    if (token.startsWith('/')) {
      return COMMANDS.filter(c => c.startsWith(token)).map(value => ({ value }))
    }
    if (token.startsWith('@')) {
      const needle = token.slice(1).toLowerCase()
      return knownPaths
        .filter(path => path.toLowerCase().includes(needle))
        .slice(0, 8)
        .map(path => ({ value: `@${path}` }))
    }
    return []
  }, [token, knownPaths])

  function accept(suggestion: Suggestion): void {
    setValue(
      value.slice(0, value.length - token.length) + suggestion.value + ' ',
    )
    setSelected(0)
    inputRef.current?.focus()
  }

  function submit(delivery: 'next' | 'interrupt'): void {
    const text = value.trim()
    if (!text) return
    onSubmit(text, delivery)
    setValue('')
    setSelected(0)
  }

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
                {suggestion.value}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="composer__row">
        <textarea
          ref={inputRef}
          className="composer__input"
          value={value}
          rows={1}
          placeholder={
            busy
              ? 'Working. Enter queues, shift+Enter interrupts.'
              : 'Message, or / for a command'
          }
          onChange={event => setValue(event.target.value)}
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
              if (event.altKey) return
              event.preventDefault()
              // Shift+Enter while busy means "stop that and do this instead",
              // which the process handles as one atomic queue operation.
              submit(event.shiftKey && busy ? 'interrupt' : 'next')
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn btn--stop" onClick={onInterrupt}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--send"
            onClick={() => submit('next')}
            disabled={!value.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
