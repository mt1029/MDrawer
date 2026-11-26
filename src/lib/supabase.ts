import { createClient } from '@supabase/supabase-js'
import { strings } from '../strings.ts'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// Vite 在 build 時把這兩個值寫進打包檔。
// 本機讀 .env.local；Vercel 讀專案的 Environment Variables（改完要重新部署）。
if (!url || !publishableKey) {
  throw new Error(strings.errors.missingEnv)
}

export const supabase = createClient(url, publishableKey)
