import type { WirePermissionMode } from '../../../session/wire.js'

export function ModePicker({
  active,
  modes,
  onSetMode,
}: {
  active?: WirePermissionMode | null
  /** `catalog.permissionModes`: the server polices which ones this client may set. */
  modes: WirePermissionMode[]
  onSetMode(mode: WirePermissionMode): void
}): React.ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">permission mode</h2>
      <div className="modes">
        {modes.map(mode => (
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
      {/* The catalog omits modes a remote surface must not hold (a mode that
          stops asking is what an attacker would choose), and the server
          refuses them on the route regardless of what is rendered here. */}
    </section>
  )
}
