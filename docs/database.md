# 資料表與隔離測試（第 2 步：nodes 表、觸發器、RLS）

SQL 在 [supabase/migrations/20261123000000_create_nodes.sql](../supabase/migrations/20261123000000_create_nodes.sql)。內容以 spec 第 5 節為基礎，並加上 11/23 審查後同意的修改：

| 修改 | 原因 |
| --- | --- |
| 明確 `grant` 給 `authenticated`，並撤銷 `anon` 的權限 | 2026/5/30 之後建立的 Supabase 專案，新資料表不會自動開放給前端 |
| `user_id` 加 `on delete cascade` | 不加的話，帳號底下有資料時，在 Dashboard 會刪不掉這個帳號 |
| 觸發器在新增時強制 `version = 1`、`created_at = now()`，更新時鎖住 `created_at` | 原版在新增時，前端仍可自己填這兩個欄位 |
| RLS 加 `to authenticated`，並改用 `(select auth.uid())` | Supabase 官方建議的效能寫法 |
| 上層資料夾改用 `(user_id, parent_id)` 複合外鍵，並禁止指向自己 | 外鍵檢查不受 RLS 限制，原版讓別人能把項目掛到你的資料夾下 |
| 同層名稱不分大小寫 | 避免 ZIP 在 macOS、Windows 解壓時撞名 |

## A. 在 Supabase 執行 SQL

1. Supabase Dashboard → **SQL Editor** → **New query**。
2. 把整份 `.sql` 檔貼進去，按 **Run**。
3. 看到 `Success. No rows returned` 就完成了。整份 SQL 包在一個交易裡，中途出錯會全部還原，不會只建一半。

確認：

- **Table Editor** 出現 `nodes` 表，旁邊**沒有**「RLS disabled」或「Unrestricted」的警告。
- **Authentication → Policies**（或 Table Editor 裡 nodes 的 RLS policies）看得到 `own_nodes`。
- **Advisors → Security Advisor** 裡沒有跟 `nodes` 或 `nodes_touch` 有關的警告。

## B. 準備測試帳號

用第 1 步建好的 A、B 兩個帳號。在專案根目錄建立 `.env.test.local`（已被 `.gitignore` 擋掉，不會進 Git）：

```
TEST_A_EMAIL=A 帳號的信箱
TEST_A_PASSWORD=A 帳號的密碼
TEST_B_EMAIL=B 帳號的信箱
TEST_B_PASSWORD=B 帳號的密碼
```

只填測試帳號，**不要放你在其他網站用的密碼**。

## C. 執行隔離測試

```bash
npm run test:rls
```

腳本會用 A、B 兩個帳號登入 Supabase，在 A 底下建立一個「RLS 測試 <時間>」資料夾，然後逐項檢查。結束時會刪除所有測試資料。預期每一行都是 ✅，最後顯示：

```
已清除測試資料
全部通過
```

檢查項目：

| 類別 | 項目 |
| --- | --- |
| 觸發器 | 新增時 `version`、`created_at` 由資料庫決定；更新時 `version` 加 1、`updated_at` 變新、`created_at` 不變 |
| 名稱限制 | 同層同名（大小寫不同也算）被擋；不同層可同名；`../x`、`a/b`、`a\b`、空字串被擋；標記刪除後可重用名稱 |
| 樹狀結構 | 上層資料夾不能是自己 |
| 帳號隔離 | B 讀、改、刪 A 的資料都是 0 筆；B 冒用 A 的 `user_id` 被擋；B 不能把筆記放進 A 的資料夾；B 不能把自己的筆記轉給 A；A 看不到 B 的筆記 |
| 未登入 | 讀不到任何資料 |

執行結果可以截圖放進報告，作為「讀取或改動他人資料」這項風險的驗證證據（spec 第 7 節）。

## D. 手動抽查（選做）

腳本已經涵蓋 spec 要求的隔離測試。想親眼確認的話：

1. 在 Table Editor 對 `nodes` 按 **Insert row**，`user_id` 選 A 的 id，建一筆資料。
2. SQL Editor 上方的角色選單改成 **authenticated**，並選擇 B 帳號，執行 `select * from nodes;`，應該是 0 筆。
3. 改選 A 帳號再執行一次，應該看得到剛剛那筆。

## 常見問題

| 狀況 | 原因與處理 |
| --- | --- |
| 執行 SQL 出現 `relation "nodes" already exists` | 已經執行過了，不用再跑 |
| 測試第一項就失敗，訊息含 `relation ... does not exist` 或 `Could not find the table` | SQL 還沒執行，或執行在別的專案 |
| 訊息含 `permission denied for table nodes` | SQL 裡的 `grant` 沒執行到，重新檢查 A 步驟 |
| `A 帳號登入失敗：Invalid login credentials` | `.env.test.local` 的信箱或密碼打錯 |
| `node: .env.test.local: not found` | 還沒建立 `.env.test.local`（見 B） |
| 想把表整個砍掉重建 | SQL Editor 執行 `drop table public.nodes; drop function public.nodes_touch();`，**會刪掉所有筆記**，只在還沒有正式資料時做 |

---

# 圖片儲存（第 4 步：貼圖）

SQL 在 [supabase/migrations/20261123010000_create_images_bucket.sql](../supabase/migrations/20261123010000_create_images_bucket.sql)。與 spec 第 5 節的差異：

| 修改 | 原因 |
| --- | --- |
| bucket 同時接受 `image/webp` 與 `image/jpeg` | Safari（含所有 iPhone 瀏覽器）的 Canvas 無法輸出 WebP，改存 JPEG |
| 路徑為「使用者 id/圖片 id」，不加副檔名 | 同一個 `img:<id>` 可能是 WebP 或 JPEG，格式記在 Content-Type |
| 政策用正規表示式限制完整路徑 | spec 寫「檔名一律 UUID」，原版政策只檢查第一層資料夾 |
| 改用 `(select auth.uid())` | 與 nodes 表相同的效能寫法 |

## A. 執行 SQL

1. SQL Editor → New query → 貼上整份 `.sql` → Run。
2. 確認：
   - **Storage** 出現 `images` bucket，標示為 Private。
   - bucket 設定裡，檔案大小上限 2 MB，允許的類型為 `image/webp`、`image/jpeg`。
   - **Storage → Policies** 裡，`images` 底下有 `own_images`。

## B. 驗證

| # | 操作 | 預期結果 |
| --- | --- | --- |
| 1 | 用 A 帳號開一篇筆記，截圖後在編輯區按 Ctrl+V（Mac 為 Cmd+V） | 上方依序顯示「正在壓縮圖片...（原始大小）」「上傳中...（壓縮後大小）」「已插入圖片」，編輯區插入 `![](img:…)`，預覽顯示圖片 |
| 2 | 按「插入圖片」選一張手機或相機照片 | 同上，大圖會被縮小 |
| 3 | 重新整理頁面 | 圖片仍正常顯示 |
| 4 | Storage → images → A 的 id 資料夾 | 看得到剛上傳的檔案，類型為 `image/webp`（Safari 為 `image/jpeg`） |
| 5 | 複製 A 筆記裡的 `![](img:…)`，貼到 B 帳號的筆記 | B 的預覽只顯示虛線框，看不到圖片 |
| 6 | 用 Safari 貼圖 | 正常插入；照第 4 項看 Storage，類型為 `image/jpeg` |
| 7 | 在筆記裡寫 `![](https://example.com/a.png)`，到 Vercel 網址看預覽 | 圖片不顯示，Console 有 Content-Security-Policy 的訊息（本機 `npm run dev` 沒有 CSP，所以會顯示） |

## 常見問題

| 狀況 | 原因與處理 |
| --- | --- |
| 「找不到 images bucket」 | 圖片的 SQL 還沒執行 |
| 「沒有權限上傳圖片」 | 政策沒建立成功，或登入已過期，重新登入後再試 |
| 執行 SQL 出現 `duplicate key value violates unique constraint "buckets_pkey"` | bucket 已經存在，可能在 Dashboard 手動建過。到 Storage 刪掉 `images` bucket 後重跑，或只執行 `create policy` 那段 |
| Vercel 上整個網站壞掉，Console 一堆 Content-Security-Policy 錯誤 | `VITE_SUPABASE_URL` 與實際專案不符，CSP 會擋掉 Supabase 的連線。確認環境變數後 Redeploy |

# 資料夾裡的圖片（11/26：圖片放進資料夾第 1 步）

圖片跟資料夾、筆記一樣是 `nodes` 的一列，`type` 為 `image`，可以在檔案總管改名、移動、複製、刪除。`content` 是 Storage 裡圖片檔的 uuid（`images` bucket 的「使用者 id/uuid」）。複製圖片時兩列共用同一個檔案（離線也能複製），所以檔案的 uuid 不放在 `id`。

SQL 在 [supabase/migrations/20261126000000_images_in_folders.sql](../supabase/migrations/20261126000000_images_in_folders.sql)，只改 `type` 的檢查、加一條「圖片的 content 必須是 uuid」，RLS、觸發器、索引、Storage 政策都不變。

## A. 執行 SQL

1. SQL Editor → New query → 貼上整份 `.sql` → Run。只需執行一次。
2. 確認：**Database → Tables → nodes → Constraints** 有 `nodes_type_check`（`folder`、`note`、`image`）與 `nodes_image_file`。

還沒執行時，新增圖片會推送失敗，側欄顯示「1 項修改無法同步：名稱不符格式…」（資料庫的檢查擋下來，錯誤代碼跟名稱規則相同，所以訊息是名稱的）。執行後按重新整理就會推送。

## B. 驗證

| # | 操作 | 預期結果 |
| --- | --- | --- |
| 1 | 終端機執行 `npm run test:rls` | 全部 ✅，多了 4 項：圖片項目可以建立、沒有 content 被擋、content 不是 uuid 被擋、不認得的 type 被擋 |
| 2 | 終端機執行 `npm run test:sync` | 全部 ✓（同步用的請求沒有變） |
| 3 | 在資料夾上按右鍵 →「上傳圖片」，選兩張同名的照片 | 側欄上方顯示「正在上傳圖片...（1/2）」→「已上傳 2 張圖片。」；資料夾裡多了「照片.webp」「照片 (2).webp」（Safari 為 .jpg），右側顯示最後一張的預覽與寬 × 高 |
| 4 | Table Editor → nodes | 兩列的 `type` 是 `image`，`content` 是 uuid；Storage → images → 你的 id 資料夾裡有同樣 uuid 的檔案 |
| 5 | 複製其中一張貼到別的資料夾，再刪掉原本那張，等幾秒 | Storage 裡的檔案還在（副本還在用） |
| 6 | 把副本也刪掉，等幾秒 | Storage 裡的檔案不見了 |
| 7 | 匯出 ZIP | 圖片在它所在的資料夾裡（例如 `課程/照片.webp`），沒有另外的 `images/` 資料夾（除非還有舊的 `![](img:…)` 筆記） |

## 同步檢查（離線 L2）

`npm run test:sync` 用同樣的 A、B 測試帳號，在真正的 Supabase 上執行 App 的同步請求（`src/lib/cloud.ts`）。它不改資料表、政策或觸發器，只新增一組測試資料，結束時刪除。檢查項目與說明見 [offline.md](offline.md) 的驗證一節。
