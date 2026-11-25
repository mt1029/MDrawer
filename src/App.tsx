import { useEffect, useLayoutEffect, useState } from 'react'
import AuthForm from './components/AuthForm.tsx'
import ConfirmDialog from './components/ConfirmDialog.tsx'
import ExportDialog from './components/ExportDialog.tsx'
import Workspace from './components/Workspace.tsx'
import { mirror } from './lib/repo.ts'
import { supabase } from './lib/supabase.ts'
import { useMirror } from './lib/useMirror.ts'
import { useOnline } from './lib/useOnline.ts'
import { useSession } from './lib/useSession.ts'

/** 不能連到雲端時的提示：修改先存在本機，之後自動同步 */
function LocalOnlyBanner({ online }: { online: boolean }) {
  return (
    <p className="offline-banner" role="status">
      {online
        ? '正在確認登入狀態：修改會先存在這台裝置，確認後自動同步。持續很久的話請重新整理頁面。'
        : '離線中：修改會先存在這台裝置，恢復連線後自動同步。圖片要連線才能插入與顯示。'}
    </p>
  )
}

export default function App() {
  const session = useSession()
  const online = useOnline()
  const local = useMirror()
  const [signingOut, setSigningOut] = useState(false)
  // 登出前發現還有未同步的修改：顯示確認對話框（數字為筆數）
  const [unsyncedOnSignOut, setUnsyncedOnSignOut] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void mirror.load()
  }, [])

  // 使用中的帳號：有登入就用登入的帳號。
  // 沒有有效登入、但這台裝置有本機資料時，代表沒有登出、只是離線期間登入權杖過期，
  // 這時用本機資料的帳號開啟，照樣可以讀寫，登入恢復後再同步。
  // 被強制登出、留下未同步修改的（signedOut）例外：要重新登入。
  const owner = local.owner
  const user = session
    ? { id: session.user.id, email: session.user.email ?? '' }
    : session === null && owner && !owner.signedOut
      ? { id: owner.userId, email: owner.email }
      : null
  const signedIn = Boolean(session)
  // 被強制登出後改用別的帳號登入：先問要不要丟棄前一個帳號還沒同步的修改
  const othersUnsynced = Boolean(session && owner?.signedOut && owner.userId !== session.user.id)
  const userId = user?.id
  const email = user?.email ?? ''

  // 用 useLayoutEffect：要在子元件的 useEffect 之前執行，子元件讀資料時 mirror 已經知道是誰、有沒有登入
  useLayoutEffect(() => {
    if (userId && !othersUnsynced) void mirror.activate(userId, email, signedIn)
  }, [userId, email, signedIn, othersUnsynced])

  // App 開啟時、恢復連線時、登入恢復時同步（另外每 30 秒、修改後 2 秒由 mirror 自己排程）
  const active = userId !== undefined && local.activeUserId === userId
  useEffect(() => {
    if (active && signedIn && online) void mirror.sync()
  }, [active, signedIn, online])

  if (session === undefined || !local.ready) {
    return <p className="loading">載入中…</p>
  }

  if (othersUnsynced && owner) {
    return (
      <main className="auth">
        <div className="card">
          <h2>這台裝置有其他帳號的資料</h2>
          <p>
            {owner.email} 在這台裝置上有 {local.pendingCount} 項修改還沒同步到雲端。用目前的帳號繼續，會刪除這些修改。
          </p>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => void supabase.auth.signOut({ scope: 'local' })}>
              改用 {owner.email} 登入
            </button>
            <button type="button" className="danger" onClick={() => void mirror.signOut()}>
              刪除這些修改並繼續
            </button>
          </div>
        </div>
      </main>
    )
  }

  if (!user) {
    return (
      <>
        {!online && (
          <p className="offline-banner" role="status">
            目前離線，登入與註冊需要網路。
          </p>
        )}
        {owner?.signedOut && (
          <p className="offline-banner" role="status">
            登入已失效，請重新登入。這台裝置上有 {owner.email} 的 {local.pendingCount} 項修改還沒同步，用同一個帳號登入後會自動同步。
          </p>
        )}
        <AuthForm />
      </>
    )
  }

  // 等確認本機資料是這個帳號的之後才顯示（避免讀到別人的資料）
  if (!active && !signingOut) {
    return <p className="loading">載入中…</p>
  }

  const cloud = online && signedIn
  const hasLocalCopy = active && owner?.userId === userId

  async function finishSignOut() {
    setUnsyncedOnSignOut(null)
    setSigningOut(true)
    try {
      // 先清掉這台裝置上的本機資料（spec 第 7 節），再登出
      await mirror.signOut()
    } catch (err) {
      console.warn('清除本機資料失敗', err)
    }
    // scope: 'local' 只登出這個瀏覽器；預設 'global' 會連其他裝置一起登出
    await supabase.auth.signOut({ scope: 'local' })
    setSigningOut(false)
  }

  async function handleSignOut() {
    setSigningOut(true)
    let pending = await mirror.countPending().catch(() => 0)
    // 還有未同步的修改：能連線就先同步一次
    if (pending > 0 && cloud) {
      await mirror.sync()
      pending = await mirror.countPending().catch(() => 0)
    }
    setSigningOut(false)
    // spec 第 6 節登出保護：佇列不是空的，要先警告
    if (pending > 0) setUnsyncedOnSignOut(pending)
    else await finishSignOut()
  }

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
            disabled={!cloud || !hasLocalCopy}
            title={cloud ? '把所有筆記匯出成 ZIP' : '離線時無法匯出（圖片要從雲端下載）'}
          >
            匯出
          </button>
          <button type="button" onClick={() => void handleSignOut()} disabled={signingOut}>
            {signingOut ? '登出中…' : '登出'}
          </button>
        </span>
      </header>
      {!cloud && <LocalOnlyBanner online={online} />}
      {hasLocalCopy ? (
        <Workspace cloud={cloud} />
      ) : (
        <main className="detail first-sync">
          {!cloud ? (
            <p className="detail-placeholder">這台裝置還沒有你的筆記。連線後會自動下載，之後離線也能使用。</p>
          ) : local.syncError ? (
            <>
              <p className="message error" role="alert">
                下載筆記失敗：{local.syncError}
              </p>
              <p>
                <button type="button" onClick={() => void mirror.sync()}>
                  重試
                </button>
              </p>
            </>
          ) : (
            <p className="detail-placeholder">正在下載你的筆記…</p>
          )}
        </main>
      )}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {unsyncedOnSignOut !== null && (
        <ConfirmDialog
          title="還有修改沒有同步"
          confirmLabel="仍要登出"
          danger
          onConfirm={finishSignOut}
          onClose={() => setUnsyncedOnSignOut(null)}
        >
          <p>
            有 {unsyncedOnSignOut} 項修改還沒同步到雲端。登出會清除這台裝置上的資料，這些修改會遺失。
            {online ? '' : '目前離線，建議恢復連線、等同步完成後再登出。'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
