import { useEffect, useState } from 'react'
import { whoAmI } from './api.js'
import { Login } from './components/Login.js'
import { Shell } from './components/Shell.js'

/** The authentication gate. Everything else lives below `Shell`. */
export function App(): React.ReactElement {
  const [csrf, setCsrf] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    void whoAmI().then(me => {
      if (me) setCsrf(me.csrf)
      setChecked(true)
    })
  }, [])

  if (!checked) return <main className="boot">…</main>
  if (!csrf) return <Login onAuthenticated={setCsrf} />
  return <Shell csrf={csrf} />
}
