import type { AuthError } from '@supabase/supabase-js'
import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase.ts'
import { strings } from '../strings.ts'

type Mode = 'signIn' | 'signUp'

// Supabase 預設密碼最少 6 個字元（Authentication → Providers → Email 可調整）
const MIN_PASSWORD_LENGTH = 6

/** Supabase 的錯誤代碼換成中文訊息（strings.auth.errors）；沒有對應的直接顯示 Supabase 的英文訊息 */
function toMessage(error: AuthError): string {
  // status 0 代表請求沒有送到伺服器（斷網、網址打錯）
  if (error.status === 0) return strings.auth.supabaseUnreachable
  if (error.code === 'weak_password') return strings.auth.weakPassword(MIN_PASSWORD_LENGTH)
  return (error.code && strings.auth.errors[error.code]) || error.message
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
          setError(strings.auth.errors.user_already_exists)
        } else if (!data.session) {
          // 有 user 但沒有 session：需要先到信箱點驗證連結
          setNotice(strings.auth.verificationSent(email))
          setMode('signIn')
          setPassword('')
        }
        // 有 session 代表 Supabase 已關閉信箱驗證，useSession 會自動切到登入後畫面
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) setError(toMessage(error))
      }
    } catch {
      setError(strings.errors.network)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <h1 className="brand">{strings.common.appName}</h1>
      <p className="tagline">{strings.auth.tagline}</p>

      <form className="card" onSubmit={handleSubmit}>
        <h2>{isSignUp ? strings.auth.signUp : strings.auth.signIn}</h2>

        <label>
          {strings.auth.email}
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
          {strings.auth.password}
          <input
            type="password"
            name="password"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            required
            minLength={isSignUp ? MIN_PASSWORD_LENGTH : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {isSignUp && <small>{strings.auth.passwordHint(MIN_PASSWORD_LENGTH)}</small>}
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
          {busy ? strings.common.processing : isSignUp ? strings.auth.createAccount : strings.auth.signIn}
        </button>

        <p className="switch">
          {isSignUp ? strings.auth.haveAccount : strings.auth.noAccount}
          <button type="button" className="link" onClick={switchMode}>
            {isSignUp ? strings.auth.switchToSignIn : strings.auth.switchToSignUp}
          </button>
        </p>
      </form>
    </main>
  )
}
