import { useMemo, useState } from 'react'
import type { WireRequest } from '../../../session/wire.js'
import {
  elicitationContent,
  elicitationFields,
  type ElicitationValues,
} from '../trayViews.js'

type ElicitationEntry = Extract<WireRequest, { kind: 'elicitation' }>

/**
 * An MCP elicitation: a form the server built and the browser fills.
 *
 * The schema arrives as JSON at request time and never changes while open,
 * so the field list is derived once. A URL elicitation instead shows its
 * waiting state — the user's real step happens in another tab, and the only
 * answer left here is to give up.
 */
export function ElicitationTray({
  request,
  queued,
  onRespond,
}: {
  request: ElicitationEntry
  queued: number
  onRespond(
    response:
      | { action: 'accept'; content?: Record<string, unknown> }
      | { action: 'decline' }
      | { action: 'cancel' },
  ): void
}): React.ReactElement {
  const fields = useMemo(
    () => elicitationFields(request.params),
    [request.params],
  )
  const [values, setValues] = useState<ElicitationValues>({})
  const [error, setError] = useState('')

  function setValue(name: string, value: string | boolean): void {
    setValues(prev => ({ ...prev, [name]: value }))
  }

  function submit(): void {
    const result = elicitationContent(fields, values)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onRespond({ action: 'accept', content: result.content })
  }

  return (
    <section className="tray" role="alertdialog" aria-label="Server form">
      <header className="tray__head">
        <span className="tray__tool">mcp · {request.serverName}</span>
        {queued > 1 ? (
          <span className="tray__queued">+{queued - 1} waiting</span>
        ) : null}
      </header>

      {request.waiting ? (
        <>
          <p className="tray__desc elicitation__waiting">
            Waiting for the browser step opened by this server — finish it in
            its own tab, or cancel here.
          </p>
          <div className="tray__actions">
            <button
              type="button"
              className="btn btn--deny"
              onClick={() => onRespond({ action: 'cancel' })}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {fields.length > 0 ? (
            <div className="elicitation__fields">
              {fields.map(field => (
                <div className="elicitation__row" key={field.name}>
                  <label
                    className="elicitation__label"
                    htmlFor={`elicit-${field.name}`}
                  >
                    {field.label}
                    {field.required ? (
                      <span className="elicitation__required">*</span>
                    ) : null}
                  </label>
                  {field.type === 'checkbox' ? (
                    <input
                      id={`elicit-${field.name}`}
                      className="elicitation__check"
                      type="checkbox"
                      checked={values[field.name] === true}
                      onChange={event =>
                        setValue(field.name, event.target.checked)
                      }
                    />
                  ) : field.type === 'select' ? (
                    <select
                      id={`elicit-${field.name}`}
                      className="elicitation__input"
                      value={
                        typeof values[field.name] === 'string'
                          ? (values[field.name] as string)
                          : ''
                      }
                      onChange={event =>
                        setValue(field.name, event.target.value)
                      }
                    >
                      <option value="">—</option>
                      {field.options?.map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`elicit-${field.name}`}
                      className="elicitation__input"
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={
                        typeof values[field.name] === 'string'
                          ? (values[field.name] as string)
                          : ''
                      }
                      onChange={event =>
                        setValue(field.name, event.target.value)
                      }
                    />
                  )}
                  {field.description ? (
                    <span className="elicitation__desc">
                      {field.description}
                    </span>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="tray__desc">
              This server is asking for a plain yes or no.
            </p>
          )}

          {error ? <p className="tray__error">{error}</p> : null}

          <div className="tray__actions">
            <button
              type="button"
              className="btn btn--deny"
              onClick={() => onRespond({ action: 'decline' })}
            >
              Decline
            </button>
            <button type="button" className="btn btn--allow" onClick={submit}>
              Submit
            </button>
          </div>
        </>
      )}
    </section>
  )
}
