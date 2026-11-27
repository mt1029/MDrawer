// repo 的線上實作：直接讀寫 Supabase（核心層 C 使用；L2 起資料改由本機讀寫，這裡只負責圖片與同步）。
// 不送 user_id、version、created_at、updated_at：前兩者由 RLS 預設值與觸發器處理，後兩者只由資料庫寫入。

import { createCloud, toRepoError } from './cloud.ts'
import {
  RepoError,
  normalizeName,
  numberedName,
  sortNodes,
  validateName,
  type NodeMeta,
  type NodeType,
  type TreeNode,
} from './nodes.ts'
import type { CreateNodeInput, Repo, UpdateNodeInput } from './repo.ts'
import { supabase } from './supabase.ts'
import { groupTrash, purgeEntries, restoreEntry } from './trash.ts'
import { strings } from '../strings.ts'

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
      // 圖片的 content 是圖片檔 id（資料庫會檢查格式）。核心層的線上版不支援 rename，L2 起由本機版處理
      content: input.type === 'folder' ? null : input.type === 'note' ? (input.content ?? '') : (input.content ?? null),
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
      throw new RepoError('invalid_move', strings.errors.nodes.moveIntoSelf)
    }
    if (visited.has(currentId)) {
      throw new RepoError('invalid_move', strings.errors.nodes.cycle)
    }
    visited.add(currentId)
    const { data, error, status } = await supabase
      .from('nodes')
      .select('id, parent_id, type')
      .eq('id', currentId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw toRepoError(error, status)
    if (!data) throw new RepoError('not_found', strings.errors.nodes.targetNotFound)

    const row = data as { parent_id: string | null; type: NodeType }
    if (isTarget && row.type !== 'folder') {
      throw new RepoError('invalid_move', strings.errors.nodes.moveOnlyToFolder)
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
      throw new RepoError('duplicate_name', strings.errors.nodes.duplicateNameInTarget)
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

async function copyNode(id: string, targetParentId: string | null): Promise<NodeMeta> {
  const source = await getNode(id)
  if (!source) throw new RepoError('not_found', strings.errors.nodes.notFound)
  if (targetParentId) {
    // 從目標往上找，不能遇到來源（不能複製到自己底下）
    for (let current: string | null = targetParentId; current; ) {
      if (current === id) throw new RepoError('invalid_move', strings.errors.nodes.pasteIntoSelf)
      current = (await getNode(current))?.parent_id ?? null
    }
  }
  // 同名時加上「 (2)」「 (3)」…
  let top: NodeMeta | null = null
  for (let n = 1; !top; n++) {
    const name = n === 1 ? source.name : numberedName(source.name, n)
    try {
      top = await createNode({ parentId: targetParentId, type: source.type, name, content: source.content ?? undefined })
    } catch (err) {
      if (!(err instanceof RepoError && err.kind === 'duplicate_name') || n >= 20) throw err
    }
  }
  if (source.type === 'folder') {
    for (const child of await listChildren(source.id)) await copyChildren(child.id, top.id)
  }
  return top
}

async function copyChildren(id: string, parentId: string): Promise<void> {
  const source = await getNode(id)
  if (!source) return
  const copy = await createNode({ parentId, type: source.type, name: source.name, content: source.content ?? undefined })
  if (source.type === 'folder') {
    for (const child of await listChildren(source.id)) await copyChildren(child.id, copy.id)
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
  if (!id) throw new RepoError('unknown', strings.errors.sessionExpired)
  return id
}

/** 上傳圖片（id 由前端產生，Storage 的部分在 cloud.ts，同步上傳離線存的圖片也用同一個） */
async function uploadImage(image: Blob): Promise<string> {
  if (!navigator.onLine) throw new RepoError('network', strings.errors.images.offlineUpload)
  const id = crypto.randomUUID()
  await cloud.uploadImage(id, image)
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
    throw new RepoError(error.status ? 'unknown' : 'network', strings.errors.images.urlFailed)
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
    throw new RepoError(status ? 'not_found' : 'network', status ? strings.errors.images.notFound : strings.errors.images.downloadNetwork)
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
  copyNode,
  uploadImage,
  getImageUrls,
  downloadImage,
  listTrash: async () => groupTrash(await cloud.listTrash(), await listAll()),
  restoreTrash: async (entry) => restoreEntry(cloud, entry, await listAll()),
  purgeTrash: (entries) => purgeEntries(cloud, entries),
}

/** 同步用的雲端操作（sync.ts 使用） */
export const cloud = createCloud(supabase)
