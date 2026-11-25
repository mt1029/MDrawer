// repo 的線上實作：直接讀寫 Supabase（核心層 C 使用；L2 起資料改由本機讀寫，這裡只負責圖片與同步）。
// 不送 user_id、version、created_at、updated_at：前兩者由 RLS 預設值與觸發器處理，後兩者只由資料庫寫入。

import { createCloud, toRepoError } from './cloud.ts'
import {
  RepoError,
  normalizeName,
  sortNodes,
  validateName,
  type NodeMeta,
  type NodeType,
  type TreeNode,
} from './nodes.ts'
import type { CreateNodeInput, Repo, UpdateNodeInput } from './repo.ts'
import { supabase } from './supabase.ts'

const META_COLUMNS = 'id, parent_id, type, name, version, created_at, updated_at'
const FULL_COLUMNS = `${META_COLUMNS}, content`

// 一次更新太多 id 會讓網址過長，分批送出
const BATCH_SIZE = 100

function checkName(raw: string): string {
  const name = normalizeName(raw)
  const problem = validateName(name)
  if (problem) throw new RepoError('invalid_name', problem)
  return name
}

async function listChildren(parentId: string | null): Promise<NodeMeta[]> {
  let query = supabase.from('nodes').select(META_COLUMNS).is('deleted_at', null)
  query = parentId ? query.eq('parent_id', parentId) : query.is('parent_id', null)
  const { data, error, status } = await query
  if (error) throw toRepoError(error, status)
  return sortNodes(data as NodeMeta[])
}

async function getNode(id: string): Promise<TreeNode | null> {
  const { data, error, status } = await supabase
    .from('nodes')
    .select(FULL_COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw toRepoError(error, status)
  return data as TreeNode | null
}

// Supabase 一次最多回傳 1000 筆，超過要分頁讀
const PAGE_SIZE = 1000

async function listAll(): Promise<TreeNode[]> {
  const all: TreeNode[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error, status } = await supabase
      .from('nodes')
      .select(FULL_COLUMNS)
      .is('deleted_at', null)
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw toRepoError(error, status)
    all.push(...(data as TreeNode[]))
    if (data.length < PAGE_SIZE) return all
  }
}

async function createNode(input: CreateNodeInput): Promise<NodeMeta> {
  const name = checkName(input.name)
  const { data, error, status } = await supabase
    .from('nodes')
    .insert({
      id: crypto.randomUUID(),
      parent_id: input.parentId,
      type: input.type,
      name,
      content: input.type === 'note' ? (input.content ?? '') : null,
    })
    .select(META_COLUMNS)
    .single()
  if (error) throw toRepoError(error, status)
  return data as NodeMeta
}

async function updateNode(id: string, patch: UpdateNodeInput): Promise<NodeMeta> {
  const changes: UpdateNodeInput = {}
  if (patch.name !== undefined) changes.name = checkName(patch.name)
  if (patch.content !== undefined) changes.content = patch.content

  const { data, error, status } = await supabase
    .from('nodes')
    .update(changes)
    .eq('id', id)
    .is('deleted_at', null)
    .select(META_COLUMNS)
    .single()
  if (error) throw toRepoError(error, status)
  return data as NodeMeta
}

/** 確認 targetId 是資料夾，而且不是 id 本身或它的子孫（從 target 一路往上找到根目錄） */
async function assertValidMoveTarget(id: string, targetId: string): Promise<void> {
  let currentId: string | null = targetId
  let isTarget = true
  const visited = new Set<string>()

  while (currentId) {
    if (currentId === id) {
      throw new RepoError('invalid_move', '不能移到自己或自己底下的資料夾。')
    }
    if (visited.has(currentId)) {
      throw new RepoError('invalid_move', '資料夾結構出現循環，請重新整理後再試。')
    }
    visited.add(currentId)
    const { data, error, status } = await supabase
      .from('nodes')
      .select('id, parent_id, type')
      .eq('id', currentId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw toRepoError(error, status)
    if (!data) throw new RepoError('not_found', '目標資料夾不存在，可能已經被刪除。')

    const row = data as { parent_id: string | null; type: NodeType }
    if (isTarget && row.type !== 'folder') {
      throw new RepoError('invalid_move', '只能移到資料夾裡。')
    }
    isTarget = false
    currentId = row.parent_id
  }
}

async function moveNode(id: string, newParentId: string | null): Promise<NodeMeta> {
  if (newParentId) await assertValidMoveTarget(id, newParentId)

  const { data, error, status } = await supabase
    .from('nodes')
    .update({ parent_id: newParentId })
    .eq('id', id)
    .is('deleted_at', null)
    .select(META_COLUMNS)
    .single()
  if (error) {
    const repoError = toRepoError(error, status)
    if (repoError.kind === 'duplicate_name') {
      throw new RepoError('duplicate_name', '目標資料夾裡已經有相同名稱的項目（不分大小寫）。')
    }
    throw repoError
  }
  return data as NodeMeta
}

async function deleteNode(id: string): Promise<void> {
  // 一層一層找出所有子孫。每層一次查詢，請求數等於資料夾深度
  const levels: string[][] = [[id]]
  // 兩台裝置同時移動可能造成循環，記錄看過的 id 避免無限迴圈
  const seen = new Set([id])
  let frontier = [id]
  while (frontier.length > 0) {
    const next: string[] = []
    for (let i = 0; i < frontier.length; i += BATCH_SIZE) {
      const { data, error, status } = await supabase
        .from('nodes')
        .select('id')
        .in('parent_id', frontier.slice(i, i + BATCH_SIZE))
        .is('deleted_at', null)
      if (error) throw toRepoError(error, status)
      for (const row of data as { id: string }[]) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          next.push(row.id)
        }
      }
    }
    if (next.length > 0) levels.push(next)
    frontier = next
  }

  // 由最深的一層往上標記。中途失敗時，上層仍在畫面上，可以再刪一次
  const deletedAt = new Date().toISOString()
  for (const ids of levels.reverse()) {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const { error, status } = await supabase
        .from('nodes')
        .update({ deleted_at: deletedAt })
        .in('id', ids.slice(i, i + BATCH_SIZE))
        .is('deleted_at', null)
      if (error) throw toRepoError(error, status)
    }
  }
}

// ── 圖片（Storage）──────────────────────────────────────────
// 路徑為「使用者 id/圖片 id」，不加副檔名，格式記在 Content-Type（WebP 或 JPEG）

const IMAGE_BUCKET = 'images'
// 簽名網址的有效時間（秒）。快取到期前 5 分鐘就重新取得
const SIGNED_URL_TTL = 60 * 60
const SIGNED_URL_MARGIN_MS = 5 * 60 * 1000

// key 用完整路徑（含使用者 id），換帳號登入時不會拿到上一個帳號的網址
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>()

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user.id
  if (!id) throw new RepoError('unknown', '登入狀態已失效，請重新登入。')
  return id
}

function toUploadError(error: { message: string; status?: number; statusCode?: string }): RepoError {
  const message = error.message.toLowerCase()
  const status = error.status ?? Number(error.statusCode)
  if (!status) return new RepoError('network', '無法連線到伺服器，圖片沒有上傳。')
  if (status === 413 || message.includes('size')) {
    return new RepoError('unknown', '圖片超過 2 MB 上限。')
  }
  if (status === 415 || message.includes('mime')) {
    return new RepoError('unknown', '圖片格式不被接受（只接受 WebP、JPEG）。')
  }
  if (message.includes('bucket not found')) {
    return new RepoError('unknown', '找不到 images bucket，請先在 Supabase 執行建立圖片儲存的 SQL。')
  }
  if (status === 403 || message.includes('row-level security') || message.includes('unauthorized')) {
    return new RepoError('unknown', '沒有權限上傳圖片，請重新登入後再試。')
  }
  return new RepoError('unknown', `圖片上傳失敗：${error.message}`)
}

async function uploadImage(image: Blob): Promise<string> {
  if (!navigator.onLine) throw new RepoError('network', '離線時無法上傳圖片。')
  const userId = await currentUserId()
  const id = crypto.randomUUID()
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(`${userId}/${id}`, image, {
    contentType: image.type,
    // 圖片 id 不會重複使用，內容永遠不變，可以長期快取
    cacheControl: '31536000',
    upsert: false,
  })
  if (error) throw toUploadError(error)
  return id
}

async function getImageUrls(ids: string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  if (ids.length === 0) return result

  const userId = await currentUserId()
  const now = Date.now()
  const missing: string[] = []
  for (const id of ids) {
    const cached = signedUrlCache.get(`${userId}/${id}`)
    if (cached && cached.expiresAt - SIGNED_URL_MARGIN_MS > now) result[id] = cached.url
    else missing.push(id)
  }
  if (missing.length === 0) return result

  const paths = missing.map((id) => `${userId}/${id}`)
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL)
  if (error) {
    throw new RepoError(error.status ? 'unknown' : 'network', '無法取得圖片網址，請確認網路後重新整理。')
  }
  // 回傳順序與傳入的路徑相同
  missing.forEach((id, index) => {
    const url = data[index]?.signedUrl
    if (url && !data[index].error) {
      result[id] = url
      signedUrlCache.set(paths[index], { url, expiresAt: now + SIGNED_URL_TTL * 1000 })
    } else {
      result[id] = null
    }
  })
  return result
}

async function downloadImage(id: string): Promise<Blob> {
  const userId = await currentUserId()
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).download(`${userId}/${id}`)
  if (error) {
    const status = (error as { status?: number }).status
    throw new RepoError(status ? 'not_found' : 'network', status ? '找不到這張圖片。' : '無法連線到伺服器，圖片沒有下載。')
  }
  return data
}

export const onlineRepo: Repo = {
  listChildren,
  getNode,
  listAll,
  createNode,
  updateNode,
  moveNode,
  deleteNode,
  uploadImage,
  getImageUrls,
  downloadImage,
}

/** 同步用的雲端操作（sync.ts 使用） */
export const cloud = createCloud(supabase)
