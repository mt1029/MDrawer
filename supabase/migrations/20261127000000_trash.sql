-- MDrawer：垃圾桶（11/27，加分層）
-- 刪除本來就只標記 deleted_at、不實際刪列（其他裝置才同步得到「已刪除」），垃圾桶列出的就是這些列。
-- 「永久刪除」也不實際刪列（理由相同：當時離線的裝置要能同步到），改成標記 purged_at 並清掉筆記的內容，
-- 垃圾桶不再列出；圖片檔沒有其他列用到時從 Storage 刪掉（由前端處理）。
--
-- 只加一個欄位；RLS、觸發器、索引、其他限制都不變。
-- 執行方式：Supabase Dashboard → SQL Editor → New query → 貼上整份 → Run。只需執行一次。
-- 要先執行這份，再部署新版前端（新版刪除時會寫 purged_at，欄位不存在的話刪除會同步失敗）。
-- 執行後請重跑 npm run test:sync（見 docs/offline.md）。

begin;

alter table public.nodes add column purged_at timestamptz;  -- 永久刪除的時間；null 為沒有（未刪除或還在垃圾桶）

commit;
