export const MODES = ['default', 'acceptEdits', 'plan'] as const

export type Mode = (typeof MODES)[number]

export function ModePicker({
  active,
  onSetMode,
}: {
  active?: string
  onSetMode(mode: Mode): void
}): React.ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">permission mode</h2>
      <div className="modes">
        {MODES.map(mode => (
          <button
            key={mode}
            type="button"
            className={`mode ${active === mode ? 'is-active' : ''}`}
            onClick={() => onSetMode(mode)}
          >
            {mode}
          </button>
        ))}
      </div>
      {/* bypassPermissions is deliberately absent: this UI is reachable from
          the public internet behind one password. */}
    </section>
  )
}
