# AI 輔助開發紀錄

報告「製作過程 Prompt」占 60%，這份檔案是主要素材。每個功能做完當天就寫，不要留到最後一週。

## 紀錄表

| 日期 | 功能 | 提示重點 | AI 產出 | 我改了什麼、為什麼 | 驗證結果 |
| --- | --- | --- | --- | --- | --- |
| 11/22 | 規格審查 | 請 AI 檢視規格書 v1 是否可行 | 指出同步風險與 6 個技術細節問題 | 採納降級設計，改寫成 v2（差異見附錄） | 與 v1 逐項比較，列出差異表 |
| 11/23 | 規格整理與提案簡述 | 請 AI 整理規格書、刪除多餘標語，依指定格式寫提案簡述並想專題名稱 | 重排章節、合併重複內容、補上兩項遺漏（見錯誤清單）、簡述與名稱候選 | 沒怎麼改就只是改了一些用語之類的 | 看過一遍 |
| 11/23 | 建立專案與登入 | 先讀 spec 與 CLAUDE.md；只用 Vite + React + TS 建專案、接 Supabase 註冊／登入／登出、說明 Vercel 部署，不做其他功能 | 專案骨架、`src/lib/supabase.ts`、`src/lib/useSession.ts`、`src/components/AuthForm.tsx`、`docs/deploy.md`；依 spec 第 12 節範本建立 `CLAUDE.md` | 沒怎麼改我還在熟悉這個太久沒用了 | AI 端：`npm run build`、`npm run lint` 通過；未接後端時登入表單與「無法連線」訊息正常；真實註冊／登入／登出待建好 Supabase 專案後驗證（見 docs/deploy.md C、G）。原本宣稱「打包檔不含 `sb_secret`」，這個檢查無效，見錯誤清單 |
| 11/23 | nodes 表、觸發器、RLS | 照 spec 第 9 節做下一步；SQL 交給我自己在 SQL Editor 執行，並提供 A、B 帳號的隔離測試 | AI 先審查 spec 第 5 節的 SQL，提出 6 項修改讓我選（見錯誤清單）；產出 `supabase/migrations/20261123000000_create_nodes.sql`、`scripts/rls-test.mjs`（`npm run test:rls`）、`docs/database.md`；確認後把 spec 第 5 節的欄位說明與 SQL 同步成新版 | 6 項修改全部採用，包含同層名稱不分大小寫（避免 ZIP 撞名）。 | AI 端：在本機用 PGlite 模擬 Supabase 的 auth 與角色，執行同一份 SQL，23 項檢查全過（觸發器、名稱限制、A/B 隔離、未登入被拒、刪帳號連帶刪資料）。我在真實 Supabase 執行 SQL 與 `npm run test:rls`，全部通過 |
| 11/23 | repo 介面與資料夾樹 | 照 spec 第 9 節，一次只做一個功能：`repo` 介面、`repo.online.ts`、資料夾與筆記的建立／改名／移動／刪除；筆記內容的 Markdown 編輯留到下一步 | `src/lib/nodes.ts`（型別、錯誤、名稱規則）、`src/lib/repo.ts`、`src/lib/repo.online.ts`；畫面元件 `Workspace`、`FileTree`、`NameDialog`、`MoveDialog`、`ConfirmDialog` | 沒怎麼改 | AI 端：build、lint 通過。另外用記憶體版的假 repo 在瀏覽器實測：建立 5 層資料夾與筆記、重名與 `../` 的錯誤訊息、改名、移動、資料夾無法移進自己底下、刪除資料夾時子孫一併標記刪除、手機寬度沒有水平捲動。 |
| 11/23 | Markdown 編輯與預覽、XSS 測試 | 一次只做這個功能：markdown-it（`html: false`）＋ DOMPurify、即時預覽、自動儲存，並寫 XSS 測試 | `src/lib/markdown.ts`、`src/lib/markdown.test.ts`（`npm test`）、`src/components/NoteEditor.tsx` | 沒怎麼改 | AI 端：30 項測試全過（22 種 XSS 寫法、8 項語法）。為了確認測試有效，暫時拿掉防護再跑：兩道都拿掉時 12 項失敗；只留 `html: false` 時 XSS 項目全擋；只留 DOMPurify 時危險屬性被移除，但 `<svg>`、`<form>` 等標籤會出現，所以兩道都要留。瀏覽器用假 repo 實測：自動儲存、切換筆記前打的字會存下、儲存失敗會顯示重試、手機版切換編輯／預覽、XSS 字串只顯示為文字且沒有執行。 |
| 11/23 | 貼圖壓縮上傳與 CSP | 一次只做貼圖：Storage SQL 先審查再給我執行，Canvas 壓縮成 WebP，Ctrl+V 貼圖、顯示壓縮前後大小，並加上 CSP | `supabase/migrations/20261123010000_create_images_bucket.sql`、`src/lib/image.ts`、`src/lib/useImageUrls.ts`；`repo` 加上 `uploadImage`、`getImageUrls`；`markdown.ts` 在 DOMPurify 前把 `img:<id>` 換成簽名網址；`vite.config.ts` 打包時加入 CSP；確認後把 spec 第 3、4、5、7、8 節同步成實際做法 | 選擇 Safari 改存 JPEG、Storage 政策限制完整路徑、改用 `(select auth.uid())`。（其餘待填） | AI 端：Storage SQL 在 PGlite 模擬 14 項全過；單元測試 39 項全過。瀏覽器用正式版打包（CSP 生效）加假資料層實測：1.1 MB 截圖 → 23 KB WebP 並顯示；52.5 MB 雜訊圖 → 1.7 MB；模擬 Safari 改存 JPEG，透明處補白；外部圖片被 CSP 擋下；沒有其他 CSP 違規。我在真實 Supabase 執行 SQL 並實測貼圖，沒有問題 |
| 11/25 | PWA 安裝與離線外殼 | 核心層最後一項：可安裝、有圖示、離線能開啟 App 外殼；圖示先做佔位版 | `vite-plugin-pwa` 設定（manifest、service worker 預先快取 App 檔案）；`public/logo.svg` 與 `npm run icons` 產生的各尺寸圖示；`src/lib/useOnline.ts` 與離線提示；恢復連線時自動重新載入資料夾樹、補存筆記 | 沒怎麼改 | AI 端：build、lint、39 項測試通過。用正式版打包在瀏覽器實測：service worker 啟用並接管頁面、manifest 與 4 個圖示正常、沒有 CSP 違規；關掉伺服器後首頁與深層網址都能開啟；模擬斷線時顯示離線提示、存檔失敗，恢復連線後提示消失、自動補存、資料夾樹重新載入；手機寬度沒有水平捲動。我在 Vercel 網址與手機上實測安裝、離線開啟、恢復連線補存，沒有問題 |
| 11/25 | ZIP 匯出 | 標準層第一項：保留資料夾結構、圖片改為相對路徑、解壓後可直接閱讀，檔名再淨化一次 | `src/lib/exportPlan.ts`（路徑、檔名淨化、撞名處理、改寫圖片連結）、`src/lib/export.ts`（讀全部資料、下載圖片、打包）、`ExportDialog`；`repo` 加上 `listAll`、`downloadImage`；JSZip 改成按下匯出時才載入；確認後把 spec 第 5、7、8 節同步成實際做法 | 沒怎麼改 | AI 端：60 項測試全過（新增 21 項，其中一項實際打包 ZIP 再讀回來檢查每個圖片連結）；故意把相對路徑改錯時有 2 項失敗，確認測試有效。瀏覽器用假資料層匯出，再用 Finder 的解壓引擎 `ditto` 解開：結構、空資料夾、中文檔名、淨化後的檔名都正確，WebP 與 JPEG 圖片有效，連結全部找得到檔案。發現 macOS 終端機的 `unzip` 不支援 UTF-8 檔名（ZIP 本身沒問題），寫進 docs/export.md 的已知限制。真實資料：測試過創建個名叫 `images` 的資料夾，匯出的資料確實不會衝突到 |

## 錯誤清單

AI 給錯或沒想到的地方逐項記下，包含怎麼發現、怎麼修。這是過程分數最有價值的素材。

| 日期 | 問題 | 怎麼發現 | 怎麼修 |
| --- | --- | --- | --- |
| 11/23 | v2 的圖片格式 `img:<uuid>` 若在 DOMPurify 之後才替換，`src` 會被 DOMPurify 移除，預覽看不到圖 | 整理規格時對照 DOMPurify 預設允許的網址格式 | 規格改為先換成簽名網址，再交給 DOMPurify |
| 11/23 | 離線 L1 宣稱可閱讀全部筆記，但圖片用簽名網址，離線時無法顯示，規格沒寫到 | 同上，逐節檢查離線情境 | L1 改為顯示「離線時無法載入圖片」，並列入已知限制 |
| 11/23 | 規格寫「前端只用 anon key」，但 Supabase 已改推 publishable key（`sb_publishable_` 開頭），舊的 anon／service_role key 預計 2026 年底淘汰 | 實作登入時查 Supabase 官方文件 | 程式改用 `VITE_SUPABASE_PUBLISHABLE_KEY`；做完貼圖後一併同步 spec 第 7 節 |
| 11/23 | 規格把「關閉註冊需信箱驗證」寫成 demo 可選設定，但 Supabase 內建寄信服務只寄給專案團隊成員、每小時約 2 封，不關閉就無法用一般信箱註冊 | 同上，查 Supabase 寄信限制 | 部署說明改成建立專案時就關閉 Confirm email；要開啟需先設定自訂 SMTP |
| 11/23 | AI 檢查金鑰外洩時，在沒有環境變數的情況下 build，再搜尋打包檔有沒有 `sb_secret`，回報「沒有」。但沒設環境變數時 `supabase.ts` 一定會丟錯，打包工具把後面用不到的 supabase-js 整段刪掉（打包檔 230 KB，正常是 441 KB），等於掃了一個沒有套件程式的檔案。另外，搜尋字串本身也不對：supabase-js 裡本來就有 `` startsWith(`sb_secret_`) `` 用來判斷金鑰格式 | 部署後我自己在 Vercel 網址的 js 搜尋 `sb_secret_`，找到 1 筆，跟 AI 說的「應該找不到」不符 | 確認那筆是 supabase-js 的格式判斷，不是金鑰。檢查方式改成在有 `.env.local` 的情況下 build，搜尋 `sb_secret_` 後面接 10 個以上字元的字串與 `service_role`，結果都是 0 筆；docs/deploy.md G-3 已更新 |
| 11/23 | spec 的 SQL 沒有 `grant`。2026/5/30 之後建立的 Supabase 專案，新資料表不會自動開放給 Data API，照原版執行後前端會被拒絕存取 | 做第 2 步時查 Supabase changelog | SQL 加上 `grant select, insert, update, delete ... to authenticated`，並撤銷 `anon` 的權限 |
| 11/23 | `parent_id` 只用單欄外鍵。外鍵檢查不受 RLS 限制，B 只要知道 A 的資料夾 id，就能把自己的項目掛到 A 底下，也能藉此試出 id 是否存在 | 審查 SQL 時想到外鍵與 RLS 的交互作用 | 改成 `(user_id, parent_id)` 參照 `(user_id, id)` 的複合外鍵；測試「B 把筆記放進 A 的資料夾」回傳 23503 |
| 11/23 | 觸發器只在更新時改 `version`，新增時前端仍可自己填 `version`、`created_at`，違反「只由資料庫寫入」 | 對照 CLAUDE.md 的規則審查觸發器 | 新增時強制 `version = 1`、`created_at = now()`，更新時鎖住 `created_at`；測試前端傳 99 與 2000 年都被覆蓋 |
| 11/23 | `user_id` 參照 `auth.users` 沒有 `on delete cascade`，帳號底下有資料時，在 Dashboard 刪不掉這個帳號 | 審查 SQL | 加上 `on delete cascade` |
| 11/23 | 同層名稱的唯一索引區分大小寫，`Notes` 與 `notes` 可並存，但 ZIP 在 macOS、Windows 解壓時會被當成同一個資料夾 | 對照 ZIP 匯出的驗收條件 | 唯一索引改用 `lower(name)` |
| 11/23 | 觸發器用 `now()`，它是交易開始的時間，不是 commit 的時間。L2 拉取用「`updated_at >=` 上次看到的值」，晚 commit 但時間較早的修改可能永遠被漏掉 | 審查觸發器時對照第 6 節的拉取規則 | 這一步先不改。L2 實作拉取時，改成從「上次的值減幾秒」開始抓，再用 `id` + `version` 去重 |
| 11/23 | AI 第一版的手機版面：「登出」按鈕被擠成直排，整頁有 17px 的水平捲動（grid 欄位被信箱文字撐開） | AI 在瀏覽器用手機尺寸實測時發現 | 欄位改成 `minmax(0, 1fr)`、按鈕不換行；修正後頁面寬度等於畫面寬度 |
| 11/23 | spec 假設所有瀏覽器都能用 Canvas 輸出 WebP，但 Safari（含所有 iPhone 瀏覽器）不支援，而且不會報錯，會默默改成 PNG；照 spec 只收 WebP 的話，iPhone 完全不能貼圖 | 實作前查 caniuse 與 WebKit bug | 不支援時改存 JPEG（透明處補白），bucket 同時接受兩種格式，路徑不加副檔名 |
| 11/23 | spec 說貼圖預覽用 `blob:` 網址（CSP 也因此開放 `blob:`），但 DOMPurify 預設會移除 `blob:` 網址，AI 第一版照做後預覽一片空白 | AI 在瀏覽器實測時發現 `<img>` 沒有 `src`，再用 jsdom 確認 DOMPurify 的行為 | 上傳後直接取簽名網址顯示；CSP 的 `img-src` 拿掉 `blob:`，變得更嚴格 |
| 11/23 | spec 的 Storage 政策只檢查第一層資料夾是自己的 id，檔名可以隨便取，與「檔名一律 UUID」不符 | 審查 Storage SQL | 政策改用正規表示式限制完整路徑為「自己的 id/UUID」，PGlite 測試擋下 `../`、副檔名、多層資料夾等 |
| 11/25 | spec 說匯出時圖片換成「相對路徑 `images/<uuid>.webp`」，但這只對最上層的筆記成立；放在資料夾裡的筆記照寫會找不到圖 | 設計匯出時算路徑 | 依筆記所在深度加上 `../`（第二層為 `../../images/…`），並用打包後讀回的測試檢查每個連結；spec 第 5 節已改寫 |

## 每週回顧

每週末寫 3～5 行：進度、卡關、調整。

## 蒐集方式

- 重要對話存文字或截圖，標註日期與功能。
- Git：每個功能一個 commit，失敗的嘗試用分支保留。
- 關鍵功能留截圖或錄影，當作測試證據。

## 附錄：規格書 v1 與 v2 差異（11/22 規格審查結果）

| 項目 | v1 | v2 | 原因 |
| --- | --- | --- | --- |
| 離線功能 | 一次做完整同步 | 分兩級：L1 離線唯讀，L2 離線可寫並同步 | 同步是最大風險，先拿保底再往上加 |
| 衝突處理 | 5 種情況各自處理 | 只有「兩端都改同一篇筆記」存兩份，其餘一律較晚者為準 | 規則少一半，測試也少一半 |
| 離線貼圖 | 圖片先存本機、之後補傳 | 貼圖需要網路，離線時提示 | 省掉圖片佇列與重試機制 |
| 資料表 | `nodes` 含 `image` 類型、`storage_path`、`size_bytes` | `nodes` 只有 `folder`、`note`，圖片只放 Storage | 少兩個欄位、少一種類型 |
| `updated_at`、`version` | 前端寫入 | 資料庫觸發器寫入 | 避免兩台裝置時鐘不準而漏同步 |
| 開發順序 | 同步排在最後才發現問題 | 先做線上版並在第一天部署，同步最後做並設停損點 | 報告要求 URL，且線上版就是保底成果 |
| UI 資料存取 | 直接綁死 `localdb.ts` | UI 只呼叫 `repo` 介面，先接 Supabase，最後再換成本機與同步 | 不用做兩次工 |
| 功能凍結 | 12/7 | 目標 12/7，最晚 12/10 | 多留 3 天緩衝 |