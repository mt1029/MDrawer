import { useState } from 'react'
import AuthForm from './components/AuthForm.tsx'
import ExportDialog from './components/ExportDialog.tsx'
import Workspace from './components/Workspace.tsx'
import { supabase } from './lib/supabase.ts'
import { useOnline } from './lib/useOnline.ts'
import { useSession } from './lib/useSession.ts'

/** 離線提示。App 外殼由 service worker 提供，但資料要連線才能讀寫 */
function OfflineBanner() {
  return (
    <p className="offline-banner" role="status">
      目前離線：App 可以開啟，但讀寫筆記與上傳圖片需要網路。恢復連線後會自動重新載入。
    </p>
  )
}

export default function App() {
  const session = useSession()
  const online = useOnline()
  const [signingOut, setSigningOut] = useState(false)
  const [exporting, setExporting] = useState(false)

  if (session === undefined) {
    return <p className="loading">載入中…</p>
  }

  if (!session) {
    return (
      <>
        {!online && <OfflineBanner />}
        <AuthForm />
      </>
    )
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
          <button
            type="button"
            className="secondary"
            onClick={() => setExporting(true)}
            disabled={!online}
            title={online ? '把所有筆記匯出成 ZIP' : '離線時無法匯出'}
          >
            匯出
          </button>
          <button type="button" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? '登出中…' : '登出'}
          </button>
        </span>
      </header>
      {!online && <OfflineBanner />}
      <Workspace />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  )
}
