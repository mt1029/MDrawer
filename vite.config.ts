import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * 打包時在 index.html 加上 Content-Security-Policy（spec 第 7 節）。
 * 開發模式不加，因為 Vite 的熱更新需要行內 script。
 * - script 只能來自自己的網域，就算 XSS 過濾有漏洞，注入的 script 也不會執行
 * - 圖片只能來自自己的網域、Supabase（簽名網址）與 blob:。blob: 是離線時插入、還沒上傳的圖片（存在這台裝置），
 *   blob: 網址只能由這個網站自己的 script 產生；預覽裡 DOMPurify 也只放行 App 產生的那幾個（deviceImages.ts）
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
        `img-src 'self' blob: ${supabase}`,
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
    plugins: [
      react(),
      cspPlugin(supabaseUrl),
      VitePWA({
        // 有新版本時，service worker 直接換新，下次開啟就是新版。
        // 不會自動重新整理畫面，避免打到一半的筆記被打斷。
        registerType: 'autoUpdate',
        // 用外部 registerSW.js 註冊，不用行內 script，符合 CSP 的 script-src 'self'
        injectRegister: 'script',
        includeAssets: ['favicon.ico', 'logo.svg', 'apple-touch-icon-180x180.png'],
        manifest: {
          name: 'MDrawer',
          short_name: 'MDrawer',
          description: '以資料夾為核心的個人 Markdown 筆記空間',
          lang: 'zh-Hant',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          theme_color: '#ffffff',
          background_color: '#ffffff',
          icons: [
            { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // 離線外殼：預先快取打包出來的檔案，沒網路也能開啟 App 畫面
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
          navigateFallback: '/index.html',
          cleanupOutdatedCaches: true,
          // 不設定 runtimeCaching：Supabase 的登入、資料與圖片一律走網路，不快取。
          // 離線讀筆記是離線 L1 的工作（IndexedDB），不靠 service worker
        },
      }),
    ],
  }
})
