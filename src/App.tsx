import { useState } from 'react'
import AuthForm from './components/AuthForm.tsx'
import Workspace from './components/Workspace.tsx'
import { supabase } from './lib/supabase.ts'
import { useSession } from './lib/useSession.ts'

export default function App() {
  const session = useSession()
  const [signingOut, setSigningOut] = useState(false)

  if (session === undefined) {
    return <p className="loading">載入中…</p>
  }

  if (!session) {
    return <AuthForm />
  }

  async function handleSignOut() {
    setSigningOut(true)
    // scope: 'local' 只登出這個瀏覽器；預設 'global' 會連其他裝置一起登出
    await supabase.auth.signOut({ scope: 'local' })
    setSigningOut(false)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">MDrawer</span>
        <span className="account">
          <span className="email">{session.user.email}</span>
          <button type="button" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? '登出中…' : '登出'}
          </button>
        </span>
      </header>
      <Workspace />
    </div>
  )
}
