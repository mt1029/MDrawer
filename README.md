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

Supabase 設定、部署到 Vercel 與驗證步驟見 [docs/deploy.md](docs/deploy.md)。
