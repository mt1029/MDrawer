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
