import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// Vite 在 build 時把這兩個值寫進打包檔。
// 本機讀 .env.local；Vercel 讀專案的 Environment Variables（改完要重新部署）。
if (!url || !publishableKey) {
  throw new Error(
    '缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_PUBLISHABLE_KEY。' +
      '本機請照 .env.example 建立 .env.local；Vercel 請到 Settings → Environment Variables 設定後重新部署。',
  )
}

export const supabase = createClient(url, publishableKey)
