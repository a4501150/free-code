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

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setStarting(true)
    setError((await onCreate(cwd.trim() || defaultCwd)) ?? '')
    setStarting(false)
  }

  return (
    <form className="rail__new" onSubmit={start}>
      <input
        className="rail__cwd"
        value={cwd}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={defaultCwd || 'working directory'}
        onChange={event => setCwd(event.target.value)}
      />
      <button
        type="submit"
        className="rail__start"
        disabled={starting || !(cwd.trim() || defaultCwd)}
      >
        {starting ? 'starting…' : '+ new session'}
      </button>
      {error ? <p className="rail__error">{error}</p> : null}
    </form>
  )
}
