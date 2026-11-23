-- MDrawer：nodes 資料表、觸發器、RLS
-- 依 docs/spec.md 第 5 節，並套用 11/23 審查後同意的修改（見 docs/ai-log.md）。
-- 執行方式：Supabase Dashboard → SQL Editor → New query → 貼上整份 → Run。只需執行一次。

begin;

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

commit;
