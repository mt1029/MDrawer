import type { AuthError } from '@supabase/supabase-js'
import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase.ts'

type Mode = 'signIn' | 'signUp'

// Supabase 預設密碼最少 6 個字元（Authentication → Providers → Email 可調整）
const MIN_PASSWORD_LENGTH = 6

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: '信箱或密碼錯誤。',
  email_not_confirmed: '這個信箱還沒完成驗證，請先點驗證信裡的連結。',
  user_already_exists: '這個信箱已經註冊過，請直接登入。',
  email_exists: '這個信箱已經註冊過，請直接登入。',
  weak_password: `密碼強度不足，至少需要 ${MIN_PASSWORD_LENGTH} 個字元。`,
  email_address_invalid: '信箱格式不正確。',
  email_address_not_authorized:
    'Supabase 內建寄信服務只寄給專案團隊成員。請在 Supabase 關閉「Confirm email」或設定自訂 SMTP。',
  over_email_send_rate_limit: '寄信次數超過 Supabase 免費額度，請稍後再試，或在 Supabase 關閉「Confirm email」。',
  over_request_rate_limit: '嘗試次數太多，請稍後再試。',
  signup_disabled: '目前不開放註冊。',
}

function toMessage(error: AuthError): string {
  // status 0 代表請求沒有送到伺服器（斷網、網址打錯）
  if (error.status === 0) return '無法連線到 Supabase，請確認網路與 VITE_SUPABASE_URL 是否正確。'
  return (error.code && ERROR_MESSAGES[error.code]) || error.message
}

export default function AuthForm() {
  const [mode, setMode] = useState<Mode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const isSignUp = mode === 'signUp'

  function switchMode() {
    setMode(isSignUp ? 'signIn' : 'signUp')
    setError(null)
    setNotice(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // 直接從表單讀值，不用 React 的 state：瀏覽器自動填入的帳密，在使用者點擊頁面之前
    // 不會觸發 onChange，state 還是空的。點按鈕會先讓瀏覽器交出填入的值，按 Enter 則不一定，
    // 結果變成只有按按鈕才登入得了
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    setEmail(email)
    setPassword(password)
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          // 驗證信的連結回到目前網址（本機或 Vercel），該網址須列在 Supabase 的 Redirect URLs
          options: { emailRedirectTo: window.location.origin },
        })
        if (error) {
          setError(toMessage(error))
        } else if (data.user && data.user.identities?.length === 0) {
          // 開啟信箱驗證時，重複註冊不會回錯誤，而是回傳沒有 identity 的 user
          setError(ERROR_MESSAGES.user_already_exists)
        } else if (!data.session) {
          // 有 user 但沒有 session：需要先到信箱點驗證連結
          setNotice(`已寄出驗證信到 ${email}，點信中的連結後再回來登入。`)
          setMode('signIn')
          setPassword('')
        }
        // 有 session 代表 Supabase 已關閉信箱驗證，useSession 會自動切到登入後畫面
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) setError(toMessage(error))
      }
    } catch {
      setError('無法連線到伺服器，請確認網路後再試。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <h1 className="brand">MDrawer</h1>
      <p className="tagline">你自己決定目錄的 Markdown 筆記空間</p>

      <form className="card" onSubmit={handleSubmit}>
        <h2>{isSignUp ? '註冊' : '登入'}</h2>

        <label>
          信箱
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label>
          密碼
          <input
            type="password"
            name="password"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            required
            minLength={isSignUp ? MIN_PASSWORD_LENGTH : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {isSignUp && <small>至少 {MIN_PASSWORD_LENGTH} 個字元</small>}
        </label>

        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="message notice" role="status">
            {notice}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? '處理中…' : isSignUp ? '建立帳號' : '登入'}
        </button>

        <p className="switch">
          {isSignUp ? '已經有帳號？' : '還沒有帳號？'}
          <button type="button" className="link" onClick={switchMode}>
            {isSignUp ? '改為登入' : '註冊新帳號'}
          </button>
        </p>
      </form>
    </main>
  )
}
