import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { supabase } from './supabase.ts'

/**
 * 目前的登入狀態。
 * - undefined：還在從瀏覽器讀取既有登入
 * - null：未登入
 * - Session：已登入
 */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    // 訂閱後會立刻收到 INITIAL_SESSION，之後登入、登出、token 更新都會再通知
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  return session
}
