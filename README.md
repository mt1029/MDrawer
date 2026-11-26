# MDrawer

以資料夾為核心的個人 Markdown 筆記空間（PWA）。規格見 [docs/spec.md](docs/spec.md)。

## 本機開發

```bash
npm install
cp .env.example .env.local   # 填入 Supabase 的 URL 與 Publishable key
npm run dev                  # http://localhost:5173
```

| 指令 | 用途 |
| --- | --- |
| `npm run dev` | 開發伺服器 |
| `npm run build` | 型別檢查並打包到 `dist/` |
| `npm run preview` | 在本機預覽打包結果 |
| `npm run lint` | oxlint 檢查 |
| `npm test` | 執行單元測試（Markdown 與 XSS、貼圖壓縮、ZIP 匯出、離線與同步、編輯器的行號） |
| `npm run test:rls` | 用 A、B 測試帳號檢查資料隔離（見 docs/database.md） |
| `npm run test:sync` | 用 A、B 測試帳號在真正的 Supabase 上檢查同步請求（見 docs/offline.md） |
| `npm run icons` | 從 `public/logo.svg` 重新產生 PWA 圖示 |
| `npm run icons:optics` | 量介面圖示的視覺重心，產生 `scripts/icon-optics.html`；用瀏覽器打開，把結果貼到 `src/components/iconOptics.ts`（新增圖示後執行） |

- Supabase 設定、部署到 Vercel 與驗證：[docs/deploy.md](docs/deploy.md)
- 資料表、RLS 與隔離測試：[docs/database.md](docs/database.md)
- PWA 安裝、離線外殼與換圖示：[docs/deploy.md](docs/deploy.md) 最後一節
- ZIP 匯出的內容與驗證：[docs/export.md](docs/export.md)
- 離線與同步（L1、L2：離線讀寫、衝突處理、登出保護）的運作與驗證：[docs/offline.md](docs/offline.md)

## 改文案

畫面上的文字（按鈕、提示、對話框、狀態、錯誤訊息、給螢幕閱讀器的說明）都在 [`src/strings.ts`](src/strings.ts)，依畫面分組。改文案只要改這個檔案，怎麼改、哪些文字不在這裡寫在檔案開頭。
