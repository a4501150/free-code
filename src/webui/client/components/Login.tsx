import { useState } from 'react'
import { login, whoAmI } from '../api.js'

export function Login({
  onAuthenticated,
}: {
  onAuthenticated(csrf: string): void
}): React.ReactElement {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    const result = await login(password)
    setBusy(false)
    if (result === 'ok') {
      const me = await whoAmI()
      if (me) {
        onAuthenticated(me.csrf)
        return
      }
    }
    setError(
      result === 'throttled'
        ? 'Too many attempts. Wait, then try again.'
        : 'Wrong password.',
    )
    setPassword('')
  }

  return (
    <main className="login">
      <form className="login__form" onSubmit={submit}>
        <h1 className="login__title">claude web</h1>
        <input
          className="login__input"
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="password"
          onChange={event => setPassword(event.target.value)}
        />
        <button
          className="btn btn--send"
          type="submit"
          disabled={busy || !password}
        >
          {busy ? 'checking…' : 'unlock'}
        </button>
        {error ? <p className="login__error">{error}</p> : null}
      </form>
    </main>
  )
}
