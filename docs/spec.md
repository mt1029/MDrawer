# MDrawer 專題規格書

以資料夾為核心的個人 Markdown 筆記空間（PWA）。使用者自己建立、自己整理目錄，系統只負責存放、預覽、離線使用與匯出。

## 1. 專案概述

- **目標使用者**：作者本人，以及想自己掌控目錄的學生。一人一個私人空間。
- **核心價值**：目錄由使用者決定，沒網路也能看、能寫，貼上截圖就能插圖，隨時能把完整資料帶走。
- **形態**：PWA，可安裝到手機與電腦主畫面。
- **AI 的角色**：只用在開發過程（設計討論、寫程式、除錯、測試、規格審查），產品本身不內建 AI 功能。

**刻意不做**

- AI 自動分類、標籤、整理目錄。目錄由使用者決定是設計取捨，不是缺功能。
- 多人協作與即時共同編輯。
- 公開分享連結。

## 2. 痛點與需求

> TODO：用自己的話寫 5～8 行真實經驗，例如用過哪些筆記工具、哪裡不順、沒網路時想記東西卻不行、目錄被工具自動分類打亂。這段是報告「應用」章節的依據。

| 需求 | 對應功能 | 驗證方式 |
| --- | --- | --- |
| 目錄由我自己決定 | 資料夾樹：建立、改名、移動、刪除 | 建立 5 層資料夾，並把筆記移到任一層 |
| 沒網路也要能用 | 離線 L1 唯讀、L2 可寫 | 斷網後仍能開啟 App 並閱讀。L2 另需離線新增、修改，恢復連線後另一台裝置看得到 |
| 寫筆記時能直接貼圖 | 貼圖壓縮上傳 | 貼上截圖後自動插入圖片，預覽正常顯示 |
| 資料不被綁住 | ZIP 匯出 | 解壓後用任何 Markdown 編輯器開啟，圖片正常顯示 |
| 點圖示就能寫 | PWA 安裝 | 可安裝到主畫面，以獨立視窗開啟 |

## 3. 功能範圍

分三層，由上往下完成。每一層做完都是可以繳交、可以 demo 的版本，時間不夠就從後面砍。

### 核心層 C（目標 12/1）

| 功能 | 驗收條件 |
| --- | --- |
| 帳號登入 | 能註冊、登入、登出。A 帳號看不到 B 帳號的任何資料 |
| 資料夾樹 | 能建立、改名、移動、刪除。同層名稱不重複，至少 5 層 |
| Markdown 編輯與預覽 | 即時預覽，支援標題、清單、表格、程式碼區塊、圖片。預覽經 XSS 過濾 |
| 貼圖上傳 | Ctrl+V 貼圖，前端壓縮成 WebP（Safari 為 JPEG）後上傳並自動插入，介面顯示壓縮前後大小 |
| PWA 與部署 | 可安裝、有圖示，離線時能開啟 App 外殼，已部署到公開網址 |

### 標準層 S（目標 12/4～12/9）

| 功能 | 驗收條件 |
| --- | --- |
| ZIP 匯出 | 保留資料夾結構，圖片改為相對路徑，解壓後可直接閱讀 |
| 離線 L1 | 每次連線時把所有資料鏡像到 IndexedDB，斷線時可開啟並閱讀全部筆記（唯讀） |
| 離線 L2 | 斷線時可新增、修改、刪除，恢復連線自動同步，兩端都改同一篇筆記時存成兩份 |

### 加分層 X（時間不夠就整層不做）

全文搜尋、垃圾桶與還原、匯入既有 `.md`、拖曳移動、深色模式、離線貼圖。

### 停損規則

- 12/9 晚上 L2 還沒通過驗收，就停在 L1。報告把 L2 寫進「限制與未來工作」，附上已完成的部分與卡關原因。
- 落後時依序砍：加分層全部不做 → L2 降為 L1 → 匯出只保證筆記與資料夾，圖片列為限制。核心層不砍。

## 4. 系統架構與技術選型

Supabase 負責登入、雲端資料與跨裝置同步。從 L1 起，瀏覽器的 IndexedDB 也存一份完整資料，離線時改讀本機。

- UI 只呼叫 `repo` 介面（`listChildren`、`getNode`、`createNode`、`updateNode`、`moveNode`、`deleteNode`）。C 層時它直接讀寫 Supabase，L1、L2 時改成讀寫 IndexedDB 並在背景同步，UI 程式碼不必重寫。
- 登入由前端直接向 Supabase Auth 完成。圖片在連線時直接上傳到 Storage。

| 用途 | 選擇 |
| --- | --- |
| 前端 | Vite + React + TypeScript |
| 後端 | Supabase（Auth、Postgres、Storage），`@supabase/supabase-js` |
| 本機資料庫 | IndexedDB，搭配 `idb` |
| Markdown | `markdown-it`（`html: false`）＋ `DOMPurify` |
| 圖片壓縮 | Canvas 轉 WebP（Safari 改存 JPEG） |
| ZIP 匯出 | `jszip` |
| PWA | `vite-plugin-pwa` |
| 託管 | Vercel（Hobby 免費方案） |

**Supabase 免費方案**（2026/11/23 依[官方定價頁](https://supabase.com/docs/pricing)確認）

- 閒置一週會被暫停，最多 2 個啟用中的專案，檔案儲存 1 GB。
- demo 與繳交前一週要登入操作一次，確認專案沒有被暫停。
- demo 專案可在 Auth 設定關閉「註冊需信箱驗證」，並先建好兩個測試帳號。

## 5. 資料表設計

資料夾與筆記共用一張 `nodes` 表，以 `parent_id` 組成樹，移動項目只改一個欄位。圖片不進資料表，只放 Storage。

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `id` | uuid，主鍵 | 由前端產生，讓離線時也能建立新項目 |
| `user_id` | uuid | 擁有者，預設 `auth.uid()`。刪除帳號時資料一併刪除 |
| `parent_id` | uuid，可為空 | 上層資料夾，根目錄為空。必須是同一個使用者的項目，且不能是自己 |
| `type` | text | `folder` 或 `note` |
| `name` | text | 顯示名稱，同一資料夾下不可重複（不分大小寫） |
| `content` | text，可為空 | 筆記內容 |
| `version` | integer | 由觸發器寫入：新增時為 1，每次更新加 1，用來偵測衝突 |
| `created_at`、`updated_at` | timestamptz | 由觸發器以伺服器時間寫入，前端傳的值會被覆蓋 |
| `deleted_at` | timestamptz，可為空 | 標記刪除，不實際刪列，讓其他裝置同步到「已刪除」 |

實際執行的檔案是 `supabase/migrations/20261123000000_create_nodes.sql`，執行與測試方式見 `docs/database.md`。兩者內容應保持一致。

```sql
-- 資料夾與筆記共用一張表，以 parent_id 組成樹
create table public.nodes (
  id uuid primary key,                        -- 由前端產生，離線時也能建立新項目
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,  -- 刪除帳號時一併刪除資料
  parent_id uuid,                             -- 上層資料夾，根目錄為 null
  type text not null check (type in ('folder', 'note')),
  name text not null check (
    char_length(name) between 1 and 100
    and name !~ '[/\\]'
    and position('..' in name) = 0
  ),
  content text,
  version integer not null default 1,         -- 由觸發器維護，用來偵測衝突
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,                     -- 標記刪除，不實際刪列

  -- 上層資料夾必須屬於同一個使用者。外鍵檢查不受 RLS 限制，
  -- 只用 parent_id 單欄外鍵的話，別人可以把項目掛到你的資料夾下。
  constraint nodes_user_id_id_key unique (user_id, id),
  constraint nodes_parent_fkey foreign key (user_id, parent_id)
    references public.nodes (user_id, id),
  constraint nodes_parent_not_self check (parent_id is null or parent_id <> id)
);

-- 同一層未刪除的項目不可同名，且不分大小寫（避免 ZIP 在 macOS、Windows 解壓時撞名）。
-- 根目錄的 parent_id 為 null，用 coalesce 處理，不依賴 PG 版本
create unique index nodes_unique_name on public.nodes (
  user_id,
  coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(name)
) where deleted_at is null;

create index nodes_tree_idx on public.nodes (user_id, parent_id);
create index nodes_sync_idx on public.nodes (user_id, updated_at);

-- version、created_at、updated_at 一律由資料庫寫入，前端傳來的值會被覆蓋
create function public.nodes_touch() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
  else
    new.version := old.version + 1;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger nodes_touch before insert or update on public.nodes
  for each row execute function public.nodes_touch();

-- 每個人只能存取自己的資料
alter table public.nodes enable row level security;

create policy own_nodes on public.nodes for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 2026/5/30 之後建立的 Supabase 專案，新資料表不會自動開放給 Data API，要明確授權。
-- 只開放給已登入使用者；未登入（anon）一律不能存取。
revoke all on table public.nodes from anon;
grant select, insert, update, delete on table public.nodes to authenticated;
```

### 圖片儲存

- 建立私有 bucket `images`，大小上限 2 MB，只允許 `image/webp` 與 `image/jpeg`。前端一律用 Canvas 轉成 WebP；Safari（含所有 iPhone 瀏覽器）的 Canvas 無法輸出 WebP，改存 JPEG，透明處補白。
- 檔案路徑為 `{user_id}/{uuid}`，不加副檔名，格式記在檔案的 Content-Type。存取政策要求完整路徑必須是「自己的 id/UUID」。實際執行的檔案是 `supabase/migrations/20261123010000_create_images_bucket.sql`：

```sql
-- 私有 bucket：單檔上限 2 MB，只接受 WebP 與 JPEG
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 2097152, array['image/webp', 'image/jpeg']);

-- 只能存取自己的圖片，而且路徑必須是「自己的 id/UUID」
create policy own_images on storage.objects for all
  to authenticated
  using (
    bucket_id = 'images'
    and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  )
  with check (
    bucket_id = 'images'
    and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );
```

- 筆記內容裡圖片寫成 `![](img:<uuid>)`。預覽時把 `img:<uuid>` 換成 Storage 的短效簽名網址（有效 1 小時），匯出 ZIP 時依檔案格式換成相對路徑 `images/<uuid>.webp` 或 `images/<uuid>.jpg`。bucket 不必公開，匯出時的連結改寫也只是一次字串取代。
- 替換必須在 DOMPurify 過濾之前完成。DOMPurify 預設會移除 `img:` 這種非標準網址的 `src`。做法是先用 `createSignedUrls` 一次取得整篇筆記的簽名網址並快取，在 markdown-it 產生 `<img>` 時替換，再交給 DOMPurify。
- 剛貼上的圖片同樣是上傳後再取簽名網址顯示，不用本機的 `blob:` 網址，因為 DOMPurify 預設也會移除 `blob:`。
- CSP 由 `vite.config.ts` 在打包時寫入 `index.html`：`script-src 'self'`；`img-src` 與 `connect-src` 只允許自己的網域與 Supabase 專案網域，不開放 `blob:` 與外部圖片。開發模式不加 CSP，因為 Vite 的熱更新需要行內 script。

### 其他設計規則

- 刪除資料夾時，前端遞迴把它與所有子孫都標上 `deleted_at`。
- 移動資料夾時，前端要檢查目標不是自己或自己的子孫，避免形成循環。

## 6. 離線與同步

### L1 離線唯讀（約 1 天）

每次 App 啟動且有網路時，把該使用者所有未刪除的 `nodes` 寫入 IndexedDB。斷線時 UI 改讀 IndexedDB，編輯功能顯示「離線中，僅能閱讀」，圖片位置顯示「離線時無法載入圖片」。不需要佇列，也沒有衝突。

### L2 離線可寫與同步（約 3～4 天）

1. **本機寫入**：所有修改先寫入 IndexedDB，記下該筆的 `base_version`（上次從雲端看到的版本），並放入待同步佇列。
2. **推送時機**：App 啟動、`online` 事件、固定間隔（例如 30 秒）。
3. **推送順序**：佇列依「父先子後」排序再推送。否則離線時先建資料夾、再在裡面建筆記，會因為 `parent_id` 外鍵而失敗。
4. **推送方式**
   - 新項目：`upsert`，設 `onConflict: 'id'`、`ignoreDuplicates: true`，重送也安全。
   - 既有項目：`update ... where id = ? and version = base_version`，並要求回傳資料列。有回傳代表成功，沒有回傳代表雲端版本比較新，進入衝突處理。
5. **拉取**：推送完成後，抓 `updated_at >= 本機記錄的最後一筆雲端 updated_at` 的所有列（含已標刪除者）寫回 IndexedDB。時間基準一律用雲端回傳的值，不用本機時鐘。
6. **登出保護**：登出前若佇列不是空的，要警告「有未同步的修改」，確認後才清除 IndexedDB。

### 衝突處理

| 情況 | 處理方式 |
| --- | --- |
| 沒衝突（`version` 吻合） | 直接成功 |
| 兩端都改同一篇筆記的內容 | 保留雲端版本，把本機版本另存為「名稱（衝突副本 日期時間）」放在同一資料夾，由使用者自行合併 |
| 其他欄位衝突（改名、移動、刪除與修改交錯） | 以雲端最新版為底，重新套用本機這次的變更後再推送，較晚者為準。刪除不會蓋掉較新的修改 |
| 同名衝突（唯一索引錯誤 23505） | 自動在名稱後加「 (2)」重試 |

### 邊界情況

- 推送成功但回應遺失時，重送會因 `version` 不符被誤判為衝突。判為衝突時先抓雲端那筆，若內容與本機相同就視為已成功，不建立衝突副本。
- 本機新建的項目，如果父資料夾已被另一台裝置刪除，就把它放到根目錄。

## 7. 安全性設計

| 風險 | 對策 | 驗證方式 |
| --- | --- | --- |
| 筆記含惡意 HTML 或 script（XSS） | `markdown-it` 設 `html: false`，輸出再經 DOMPurify 過濾，不使用未過濾的 `innerHTML`，正式版另設 CSP（只允許自己網域的 script） | 筆記貼入 `<script>`、帶 `onerror` 的圖片、`javascript:` 連結，確認預覽不執行 |
| 讀取或改動他人資料 | `nodes` 與 Storage 都啟用 RLS，限制為 `auth.uid()` | 用 B 帳號帶 A 的 id 查詢、更新、讀圖，應查無資料 |
| 惡意或過大上傳 | 前端先壓縮並轉 WebP（Safari 為 JPEG），bucket 限制大小（2 MB）與類型，存取政策限制路徑為「自己的 id/UUID」 | 上傳改副檔名的可執行檔、超大圖片，應被拒絕 |
| 名稱含路徑字元 | 資料庫 `check` 加前端驗證，匯出 ZIP 時再淨化一次 | 建立名稱含 `../` 的項目應失敗 |
| 金鑰外洩 | 前端只用 publishable key（舊版稱 anon key），secret key 與 service_role key 不進前端與 Git，`.env*` 列入 `.gitignore` | 檢查 Git 紀錄與打包檔。打包檔裡唯一的 `sb_secret_` 是 supabase-js 判斷金鑰格式的程式碼，不是金鑰 |
| 本機資料未加密 | 登出時清除 IndexedDB，有未同步修改要先警告 | 登出後檢查本機資料庫為空 |

## 8. 已知限制

報告「限制與未來工作」直接引用這一節。

- GIF 轉成 WebP 後會變成靜態圖。
- Safari（含所有 iPhone 瀏覽器）貼上的圖會存成 JPEG，透明背景會變成白色。
- 筆記不能顯示外部網站的圖片（CSP 限制），只能顯示自己上傳的圖。
- 刪除筆記不會即時清掉圖片檔，Storage 會留下孤兒檔。
- 離線時無法貼圖，也無法顯示圖片（簽名網址需要連線取得）。
- 不做即時同步，只在 App 啟動、恢復連線與固定間隔時同步。
- 不做欄位層級的合併，同一篇內容的衝突由使用者手動合併衝突副本。
- 本機新建項目的父資料夾若已被另一台裝置刪除，會被移到根目錄。
- 部分瀏覽器在儲存空間不足時可能清除本機資料，介面要提示定期匯出 ZIP。
- 本機資料未加密，登出時清除。

## 9. 時程與里程碑

| 日期 | 內容 | 檢查點 |
| --- | --- | --- |
| 11/22～11/24 | 建立專案、接上 Supabase 登入並部署到 Vercel。建 `nodes` 表、觸發器、RLS，用兩個帳號測試隔離 | 有公開網址、能登入 |
| 11/25～11/28 | `repo` 介面與 `repo.online.ts`、資料夾樹與筆記 CRUD、Markdown 編輯預覽、XSS 測試 | 線上版可用 |
| 11/29～12/1 | 貼圖壓縮上傳、PWA 安裝與離線外殼 | 檢查點 A：核心層完成 |
| 12/2～12/4 | ZIP 匯出、`repo.local.ts` 與離線 L1 | 離線唯讀可用 |
| 12/5～12/9 | 離線 L2：待同步佇列、推送、拉取、衝突處理 | 12/9 晚上停損判斷 |
| 12/10 | 功能凍結，之後只修 bug | |
| 12/10～12/12 | 測試、截圖與錄影、整理報告與簡報 | demo 影片錄完 |
| 12/13 | 緩衝。檢查網址、測試帳號、Supabase 專案是否被暫停 | |
| 12/14 | 上課前於 TronClass 繳交文字報告、簡報、demo 影片 | |
| 12/21 | 專題發表 10 分鐘（簡報＋Demo） | |

## 10. Demo 影片腳本（3～5 分鐘）

只放確實可用的功能，沒做到的就不演。

1. 登入，簡短介紹「目錄自己決定」的理念（20 秒）
2. 建立多層資料夾、新增筆記、移動筆記（60 秒）
3. 寫 Markdown，貼上截圖，顯示壓縮前後大小（60 秒）
4. 貼入 `<script>`，示範 XSS 被擋下（20 秒）
5. 關網路後開啟 App 並閱讀。L2 完成的話，再編輯一篇、新增一篇，恢復連線後在另一個瀏覽器看到（60 秒）
6. 匯出 ZIP，解壓後用編輯器開啟（40 秒）
7. 安裝到主畫面（10 秒）

## 11. 報告項目對照

評分為成果 40%、過程（prompting）60%。

| 課程要求 | 對應內容 |
| --- | --- |
| URL | 部署網址、測試帳號 |
| 應用 | 痛點與需求、設計取捨（為什麼不做 AI 整理） |
| 技術 | 架構圖、資料表、RLS、離線同步 |
| 製作過程 Prompt | `docs/ai-log.md`，含錯誤清單與驗證結果 |
| 心得 | 每週回顧、已知限制與未來工作 |

## 12. 開發指引（給 Claude Code）

把本文件放在 `docs/spec.md`。依第 9 節的順序一次做一個功能，每個功能完成後更新 `docs/ai-log.md`。

### 專案結構

```
src/
  components/      資料夾樹、編輯器、預覽
  lib/
    supabase.ts    Supabase 用戶端
    repo.ts        UI 唯一的資料存取介面
    repo.online.ts 直接讀寫 Supabase（C 層使用）
    repo.local.ts  讀寫 IndexedDB（L1、L2 使用）
    sync.ts        同步與衝突處理（L2）
    markdown.ts    解析與過濾
    image.ts       貼圖壓縮
    export.ts      ZIP 匯出
docs/
  spec.md          本文件
  ai-log.md        AI 輔助開發紀錄
```

### CLAUDE.md 範本

```markdown
# 專案規則
- 開始前先讀 docs/spec.md。一次只做一個功能，做完停下來讓我檢查。
- UI 一律透過 src/lib/repo.ts 讀寫資料，不直接呼叫 Supabase。
- 渲染 Markdown 一律先經 DOMPurify，且 markdown-it 設 html: false。
- 不得修改 RLS 政策、觸發器或資料表結構，除非我明確同意。
- updated_at 與 version 只由資料庫寫入，前端不得自行填寫。
- 每完成一個功能，在 docs/ai-log.md 新增一列：日期、功能、提示重點、AI 產出、我修改的地方與原因、驗證結果。
- 每個功能一個 commit，訊息說明做了什麼。
```