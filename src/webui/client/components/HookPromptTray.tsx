import type { WireRequest } from '../../../session/wire.js'

type HookPromptEntry = Extract<WireRequest, { kind: 'hook_prompt' }>

/**
 * A hook waiting on a human choice. The terminal renders the same prompt
 * inline; here it is a tray, with the option descriptions as secondary
 * lines — they are the reason the hook bothered a human at all.
 */
export function HookPromptTray({
  request,
  queued,
  onSelect,
}: {
  request: HookPromptEntry
  queued: number
  onSelect(key: string): void
}): React.ReactElement {
  return (
    <section className="tray" role="alertdialog" aria-label="Hook prompt">
      <header className="tray__head">
        <span className="tray__tool">hook prompt</span>
        {queued > 1 ? (
          <span className="tray__queued">+{queued - 1} waiting</span>
        ) : null}
      </header>
      <p className="tray__desc">{request.message}</p>
      <ul className="question__options">
        {request.options.map(option => (
          <li key={option.key}>
            <button
              type="button"
              className="question__option"
              onClick={() => onSelect(option.key)}
            >
              <span className="question__label">{option.label}</span>
              {option.description ? (
                <span className="question__desc">{option.description}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
