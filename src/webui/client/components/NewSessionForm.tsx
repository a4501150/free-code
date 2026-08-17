import { useCallback, useEffect, useRef, useState } from 'react'
import { DirectoryPicker, intoDirectory } from './DirectoryPicker.js'

export function NewSessionForm({
  defaultCwd,
  onCreate,
}: {
  defaultCwd: string
  onCreate(cwd: string): Promise<string | null>
}): React.ReactElement {
  const [cwd, setCwd] = useState(() =>
    defaultCwd ? intoDirectory(defaultCwd) : '',
  )
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const owned = useRef(Boolean(defaultCwd))

  // The session list arrives on a poll, so a default can turn up after the form
  // is already open. Take it once, and never over something already in the
  // field. Setting the guard first keeps a second Strict Mode pass idle.
  useEffect(() => {
    if (owned.current || !defaultCwd) return
    owned.current = true
    setCwd(intoDirectory(defaultCwd))
  }, [defaultCwd])

  const change = useCallback((next: string) => {
    owned.current = true
    setCwd(next)
    setError('')
  }, [])

  const effective = cwd.trim()

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setStarting(true)
    setError((await onCreate(effective)) ?? '')
    setStarting(false)
  }

  return (
    <form className="rail__new" onSubmit={start}>
      <DirectoryPicker value={cwd} onChange={change} disabled={starting} />
      <button
        type="submit"
        className="rail__start"
        disabled={starting || !effective}
      >
        {starting ? 'starting…' : 'start session'}
      </button>
      {error ? <p className="rail__error">{error}</p> : null}
    </form>
  )
}
