import { useEffect, useLayoutEffect, useState } from 'react'
import AuthForm from './components/AuthForm.tsx'
import ExportDialog from './components/ExportDialog.tsx'
import Workspace from './components/Workspace.tsx'
import { formatTime } from './lib/format.ts'
import { mirror, type LocalOwner } from './lib/repo.ts'
import { supabase } from './lib/supabase.ts'
import { useMirror } from './lib/useMirror.ts'
import { useOnline } from './lib/useOnline.ts'
import { useSession } from './lib/useSession.ts'

/** 只能閱讀時的提示：說明原因，以及看到的是什麼時候的資料 */
function ReadOnlyBanner({ online, owner }: { online: boolean; owner: LocalOwner | null }) {
  let text: string
  if (!online && owner) {
    text = `離線中，僅能閱讀。顯示的是 ${formatTime(owner.syncedAt)} 存到這台裝置的資料，圖片要連線才能顯示。`
  } else if (!online) {
    text = '離線中，而且這台裝置還沒有離線副本。連線後開啟 App 一次就會自動建立。'
  } else {
    // 離線時登入權杖過期，恢復連線後要等 Supabase 換到新的權杖
    text = '已恢復連線，正在確認登入狀態，暫時只能閱讀。持續很久的話請重新整理頁面。'
  }
  return (
    <p className="offline-banner" role="status">
      {text}
    </p>
  )
}

export default function App() {
  const session = useSession()
  const online = useOnline()
  const local = useMirror()
  const [signingOut, setSigningOut] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void mirror.load()
  }, [])

  // 使用中的帳號：有登入就用登入的帳號。
  // 沒有有效登入、但這台裝置有離線副本時，代表沒有登出、只是離線期間登入權杖過期，
  // 這時用副本的帳號開啟，只能閱讀（登出時副本會被清除，所以副本還在就表示沒有登出）。
  const user = session
    ? { id: session.user.id, email: session.user.email ?? '' }
    : session === null && local.owner
      ? { id: local.owner.userId, email: local.owner.email }
      : null
  const signedIn = Boolean(session)
  const userId = user?.id
  const email = user?.email ?? ''

  // 用 useLayoutEffect：要在子元件的 useEffect 之前執行。恢復登入時 Workspace、NoteEditor 會在
  // 自己的 effect 裡重新讀資料，那時 mirror 必須已經知道「有登入」，才會讀雲端而不是副本
  useLayoutEffect(() => {
    if (userId) void mirror.activate(userId, email, signedIn)
  }, [userId, email, signedIn])

  // App 開啟時、恢復連線時，把雲端的資料整批存一份到這台裝置
  const active = userId !== undefined && local.activeUserId === userId
  useEffect(() => {
    if (active && signedIn && online) void mirror.sync()
  }, [active, signedIn, online])

  if (session === undefined || !local.ready) {
    return <p className="loading">載入中…</p>
  }

  if (!user) {
    return (
      <>
        {!online && (
          <p className="offline-banner" role="status">
            目前離線，登入與註冊需要網路。
          </p>
        )}
        <AuthForm />
      </>
    )
  }

  // 等本機副本確認是這個帳號的之後才顯示資料（避免讀到別人的副本）
  if (!active && !signingOut) {
    return <p className="loading">載入中…</p>
  }

  async function handleSignOut() {
    setSigningOut(true)
    try {
      // 先清掉這台裝置上的離線副本（spec 第 7 節），再登出
      await mirror.signOut()
    } catch (err) {
      console.warn('清除離線副本失敗', err)
    }
    // scope: 'local' 只登出這個瀏覽器；預設 'global' 會連其他裝置一起登出
    await supabase.auth.signOut({ scope: 'local' })
    setSigningOut(false)
  }

  const readOnly = !online || !signedIn

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">MDrawer</span>
        <span className="account">
          <span className="email">{user.email}</span>
          <button
            type="button"
            className="secondary"
            onClick={() => setExporting(true)}
            disabled={readOnly}
            title={readOnly ? '離線時無法匯出' : '把所有筆記匯出成 ZIP'}
          >
            匯出
          </button>
          <button type="button" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? '登出中…' : '登出'}
          </button>
        </span>
      </header>
      {readOnly && <ReadOnlyBanner online={online} owner={local.owner} />}
      <Workspace readOnly={readOnly} />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  )
}
