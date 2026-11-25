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
| `npm test` | 執行單元測試（Markdown 與 XSS、貼圖壓縮、ZIP 匯出、離線副本） |
| `npm run test:rls` | 用 A、B 測試帳號檢查資料隔離（見 docs/database.md） |
| `npm run icons` | 從 `public/logo.svg` 重新產生 PWA 圖示 |

- Supabase 設定、部署到 Vercel 與驗證：[docs/deploy.md](docs/deploy.md)
- 資料表、RLS 與隔離測試：[docs/database.md](docs/database.md)
- PWA 安裝、離線外殼與換圖示：[docs/deploy.md](docs/deploy.md) 最後一節
- ZIP 匯出的內容與驗證：[docs/export.md](docs/export.md)
- 離線 L1（本機副本、離線唯讀）的運作與驗證：[docs/offline.md](docs/offline.md)
