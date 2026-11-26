-- MDrawer：圖片放進資料夾（11/26，介面改版後的加分項）
-- 圖片跟資料夾、筆記一樣是 nodes 的一列，type 為 image，可以改名、移動、複製、刪除。
-- content 是 Storage 裡圖片檔的 uuid（images bucket 的「使用者 id/uuid」）；
-- 複製圖片時兩列共用同一個檔案，所以檔案的 uuid 不放在 id。
--
-- 只改 type 的檢查，加一條 image 的 content 必須是 uuid；RLS、觸發器、索引都不變。
-- 執行方式：Supabase Dashboard → SQL Editor → New query → 貼上整份 → Run。只需執行一次。
-- 執行後請重跑 npm run test:rls 與 npm run test:sync（見 docs/database.md、docs/offline.md）。

begin;

-- 原本的 check (type in ('folder', 'note')) 寫在欄位上，PostgreSQL 自動命名為 nodes_type_check。
-- 名稱不對時這行會失敗、整份不會生效（不用 if exists，免得舊的限制沒拿掉、新的又加上）
alter table public.nodes drop constraint nodes_type_check;
alter table public.nodes
  add constraint nodes_type_check check (type in ('folder', 'note', 'image'));

-- 圖片的 content 一定是檔案的 uuid（小寫，與 Storage 存取政策的路徑格式相同）
alter table public.nodes
  add constraint nodes_image_file check (
    type <> 'image'
    or (content is not null and content ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

commit;
