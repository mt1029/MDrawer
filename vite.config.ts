import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * 打包時在 index.html 加上 Content-Security-Policy（spec 第 7 節）。
 * 開發模式不加，因為 Vite 的熱更新需要行內 script。
 * - script 只能來自自己的網域，就算 XSS 過濾有漏洞，注入的 script 也不會執行
 * - 圖片只能來自自己的網域與 Supabase（簽名網址）。不開放 blob:，因為預覽本來就不用它（DOMPurify 會移除）
 * - 只能連線到自己的網域與 Supabase
 */
export function cspPlugin(supabaseUrl: string | undefined): Plugin {
  return {
    name: 'mdrawer-csp',
    apply: 'build',
    transformIndexHtml() {
      if (!supabaseUrl) {
        throw new Error('打包前要先設定 VITE_SUPABASE_URL（本機：.env.local；Vercel：Environment Variables）')
      }
      const supabase = new URL(supabaseUrl).origin
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        // markdown-it 的表格對齊會輸出 style="text-align:…"
        "style-src-attr 'unsafe-inline'",
        `img-src 'self' ${supabase}`,
        `connect-src 'self' ${supabase}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; ')
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 與 Vite 相同的優先順序：系統環境變數（Vercel）優先，其次是 .env.local
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL
  return {
    plugins: [react(), cspPlugin(supabaseUrl)],
  }
})
