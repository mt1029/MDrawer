import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { mirror } from './repo.ts'
import { supabase } from './supabase.ts'

/**
 * 目前的登入狀態。
 * - undefined：還在從瀏覽器讀取既有登入
 * - null：沒有有效的登入（未登入，或離線時登入權杖過期、暫時無法更新）
 * - Session：已登入
 */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    // 訂閱後會立刻收到 INITIAL_SESSION，之後登入、登出、token 更新都會再通知
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      // 登出（包含在其他分頁登出、登入被伺服器判定失效）時，清掉這台裝置上的離線副本（spec 第 7 節）
      if (event === 'SIGNED_OUT') void mirror.signOut().catch(() => undefined)
      setSession(next)
    })
    // 離線期間登入權杖過期的話，恢復連線時馬上重試更新，不必等 Supabase 每 30 秒一次的檢查。
    // 更新成功會觸發 TOKEN_REFRESHED，上面的訂閱就會收到新的 session
    const retry = () => void supabase.auth.getSession()
    window.addEventListener('online', retry)
    return () => {
      data.subscription.unsubscribe()
      window.removeEventListener('online', retry)
    }
  }, [])

  return session
}
