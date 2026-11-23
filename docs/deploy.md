# 設定、部署與驗證（第 1 步：專案與登入）

照 A → G 的順序做。A～C 在本機完成，D～G 讓它有公開網址。

## A. 建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 登入，按 **New project**。
   - Region 選離台灣近的（例如 Tokyo 或 Singapore）。
   - Database password 存進密碼管理器。前端用不到，之後在 SQL Editor 建表也不需要它。
2. **關閉信箱驗證**：Authentication → Sign In / Providers → Email，把 **Confirm email** 關掉並儲存。
   - 原因：Supabase 內建寄信服務只寄給專案團隊成員的信箱，而且每小時大約只能寄 2 封。不關掉的話，用一般信箱註冊會收到「Email address not authorized」或寄信額度錯誤。
   - 之後若要開啟，需要在 Authentication → Emails 設定自訂 SMTP。
3. **網址設定**：Authentication → URL Configuration
   - Site URL：先填 `http://localhost:5173`
   - Redirect URLs：新增 `http://localhost:5173`
   - 關閉信箱驗證時其實用不到這兩項，但先設好，之後開驗證或做「忘記密碼」才不會跳到錯的網址。
4. **取得金鑰**：專案頁上方按 **Connect** → App Frameworks → 選 React / Vite，會看到 URL 與 Publishable key。也可以到 Project Settings → API Keys 找。
   - 要複製的是 **Publishable key**（`sb_publishable_` 開頭）。舊專案也可以用 legacy **anon** key。
   - **Secret key（`sb_secret_`）與 service_role key 絕對不要放進前端或 Git。**

## B. 本機執行

```bash
cp .env.example .env.local
```

打開 `.env.local`，填入 A-4 拿到的兩個值：

```
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxx
```

```bash
npm install
npm run dev
```

瀏覽器開 <http://localhost:5173>。

## C. 本機驗證

| # | 操作 | 預期結果 |
| --- | --- | --- |
| 1 | 點「註冊新帳號」，填信箱與 6 字元以上密碼，按「建立帳號」 | 直接進入登入後畫面，右上角顯示信箱 |
| 2 | 按「登出」 | 回到登入畫面 |
| 3 | 用錯誤密碼登入 | 顯示「信箱或密碼錯誤。」 |
| 4 | 用正確密碼登入，再按 F5 重新整理 | 仍是登入狀態 |
| 5 | 用同一個信箱再註冊一次 | 顯示「這個信箱已經註冊過，請直接登入。」 |
| 6 | Supabase Dashboard → Authentication → Users | 看得到剛註冊的帳號 |
| 7 | 再註冊第二個帳號 B | 成功。A、B 兩個帳號留著，下一步測資料隔離會用到 |

## D. 推上 GitHub

先確認 `.env.local` 不會被提交：

```bash
git init
```

```bash
git add .
```

```bash
git status
```

清單裡**不能**出現 `.env.local`（`.env.example` 出現是正常的）。確認後：

```bash
git commit -m "建立 Vite + React + TS 專案並接上 Supabase 登入"
```

到 GitHub 建立新的 repository（Private 也可以，不要勾選產生 README），照頁面上 “push an existing repository” 的指令推上去，大致是：

```bash
git remote add origin https://github.com/<你的帳號>/mdrawer.git
```

```bash
git branch -M main
```

```bash
git push -u origin main
```

## E. 部署到 Vercel

1. 到 [vercel.com](https://vercel.com) 用 GitHub 帳號註冊，方案選 **Hobby**（免費）。
2. **Add New… → Project**，選剛剛的 repository，按 Import。
3. Framework Preset 應自動偵測為 **Vite**。Build Command `npm run build`、Output Directory `dist`，保持預設。
4. 展開 **Environment Variables**，新增兩筆（值跟 `.env.local` 一樣）：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
5. 按 **Deploy**。完成後會得到 `https://<專案名>.vercel.app`。

之後每次 `git push` 到 main，Vercel 都會自動重新部署。

> **注意**：Vite 是在 build 時把環境變數寫進程式。如果部署完才補或修改環境變數，要到 Deployments → 最新一筆右邊的 ⋯ → **Redeploy**，新的值才會生效。

## F. 回 Supabase 更新網址

Authentication → URL Configuration：

- Site URL 改成 `https://<專案名>.vercel.app`
- Redirect URLs 保留 `http://localhost:5173`，再新增 `https://<專案名>.vercel.app`

## G. 線上驗證

1. 在 Vercel 網址重做 C 的 1～5。
2. 用手機開同一個網址，用 A 帳號登入，確認能登入（版面不跑掉）。
3. 金鑰檢查：
   - GitHub 上的 repository 看不到 `.env.local`。
   - 在網站按 F12 → Sources（或直接開 `https://<專案名>.vercel.app/assets/index-*.js`），搜尋下面幾個字：
     - `service_role`：應該找不到。
     - `sb_secret_`：會找到 **1 筆** `` startsWith(`sb_secret_`) ``，這是 supabase-js 判斷金鑰格式的程式碼，不是金鑰。真的 secret key 會是 `sb_secret_` 後面接一長串亂碼；只要 `sb_secret_` 後面緊接著引號或反引號，就沒有問題。
     - `sb_publishable_`：找得到是正常的。這把金鑰本來就是給前端用的，資料安全由 RLS 把關（下一步建表時設定）。
   - 也可以在本機檢查（要先有 `.env.local`，打包結果才會跟線上一樣）：

     ```bash
     npm run build && grep -oE "sb_secret_[A-Za-z0-9_-]{10,}|service_role" dist/assets/*.js
     ```

     沒有輸出任何東西就是安全的。
4. 把網址記到報告的「URL」欄。

## 常見問題

| 狀況 | 原因與處理 |
| --- | --- |
| 畫面全白 | F12 → Console。看到「缺少 VITE_SUPABASE_URL…」就是環境變數沒設好：本機檢查 `.env.local`，Vercel 檢查 Environment Variables 後 Redeploy。變數名稱必須以 `VITE_` 開頭 |
| 「無法連線到 Supabase」 | `VITE_SUPABASE_URL` 打錯，或 Supabase 專案被暫停（免費方案閒置一週會暫停，到 Dashboard 按 Restore） |
| 「Email address not authorized」或寄信額度錯誤 | Confirm email 沒關，回到 A-2 |
| 驗證信的連結跳到 `localhost:3000` | Site URL 沒改，回到 A-3 / F |
| 改了 `.env.local` 沒反應 | 停掉 `npm run dev` 再重新啟動 |
