-- MDrawer：圖片 bucket 與存取政策
-- 依 docs/spec.md 第 5 節「圖片儲存」，並套用 11/23 討論後的修改（見 docs/ai-log.md）：
--   1. 同時接受 WebP 與 JPEG（Safari 的 Canvas 無法輸出 WebP，改存 JPEG）
--   2. 路徑為「使用者 id/UUID」，不加副檔名，格式由檔案的 Content-Type 決定
--   3. 政策用正規表示式限制完整路徑，並改用 (select auth.uid())
-- 執行方式：Supabase Dashboard → SQL Editor → New query → 貼上整份 → Run。只需執行一次。

begin;

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

commit;
