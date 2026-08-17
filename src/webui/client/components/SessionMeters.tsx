import { useEffect, useState } from 'react'
import type {
  WebModelOption,
  WebSessionMeta,
} from '../../protocol/attachSchemas.js'

/**
 * Keeps the tail of a path, which is the informative end. Done here rather than
 * with `direction: rtl`, which reverses mixed content: "+0 -0" became "0- 0+".
 */
function tail(path: string, max = 28): string {
  return path.length <= max ? path : `…${path.slice(-max)}`
}

/** 84,213 reads as noise in a 16rem column; 84.2k does not. */
export function compactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  return thousands < 100
    ? `${thousands.toFixed(1)}k`
    : `${Math.round(thousands)}k`
}

function Meter({
  label,
  value,
}: {
  label: string
  value: string
}): React.ReactElement {
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className="meter__value">{value}</span>
    </div>
  )
}

export function SessionMeters({
  meta,
  models,
  onSetModel,
}: {
  meta: WebSessionMeta | null
  models: WebModelOption[]
  onSetModel(model: string): void
}): React.ReactElement {
  // The session reports its model on a poll, so binding the control straight to
  // it makes the choice visibly snap back until the report arrives.
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  useEffect(() => {
    if (pendingModel && meta?.model === pendingModel) setPendingModel(null)
  }, [meta?.model, pendingModel])
  const shownModel = pendingModel ?? meta?.model ?? ''

  return (
    <section className="panel">
      <h2 className="panel__title">session</h2>
      <Meter
        label="state"
        value={
          meta
            ? // The phase is only true of a turn in flight, and the session
              // omits it otherwise, so there is nothing to suppress here.
              meta.activity
              ? `${meta.state} · ${meta.activity}`
              : meta.state
            : '—'
        }
      />
      {models.length === 0 ? (
        <Meter label="model" value={meta?.model ?? '—'} />
      ) : (
        <label className="meter">
          <span className="meter__label">model</span>
          <select
            className="meter__select"
            value={shownModel}
            onChange={event => {
              setPendingModel(event.target.value)
              onSetModel(event.target.value)
            }}
          >
            {/* The session may run a model the registry no longer lists. */}
            {shownModel && !models.some(m => m.value === shownModel) ? (
              <option value={shownModel}>{shownModel}</option>
            ) : null}
            {models.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <Meter
        label="cost"
        value={meta ? `$${(meta.costUsd ?? 0).toFixed(4)}` : '—'}
      />
      <Meter
        label="lines"
        value={
          meta ? `+${meta.linesAdded ?? 0} −${meta.linesRemoved ?? 0}` : '—'
        }
      />
      {meta?.context ? (
        <Meter
          label="context"
          value={`${compactTokens(meta.context.usedTokens)} / ${compactTokens(
            meta.context.maxTokens,
          )}  (${meta.context.usedPercent}%)`}
        />
      ) : null}
      {meta?.context?.compactPercentLeft === undefined ? null : (
        <Meter
          label="compact"
          value={`${meta.context.compactPercentLeft}% left`}
        />
      )}
      <Meter label="cwd" value={meta ? tail(meta.cwd) : '—'} />
    </section>
  )
}
