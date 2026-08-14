import { useState } from 'react'

export function NewSessionForm({
  defaultCwd,
  onCreate,
}: {
  defaultCwd: string
  onCreate(cwd: string): Promise<string | null>
}): React.ReactElement {
  const [cwd, setCwd] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const effective = cwd.trim() || defaultCwd

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setStarting(true)
    setError((await onCreate(effective)) ?? '')
    setStarting(false)
  }

  return (
    <form className="rail__new" onSubmit={start}>
      <input
        className="rail__cwd"
        value={cwd}
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Working directory"
        placeholder={defaultCwd || 'working directory'}
        onChange={event => setCwd(event.target.value)}
      />
      <button
        type="submit"
        className="rail__start"
        disabled={starting || !effective}
      >
        {starting ? 'starting…' : 'start session'}
      </button>
      {/* The browser cannot browse the filesystem, so with no session to copy a
          directory from there is nothing to prefill. Say so. */}
      {!effective ? (
        <p className="rail__hint">Type an absolute path on the host.</p>
      ) : null}
      {error ? <p className="rail__error">{error}</p> : null}
    </form>
  )
}
