// repo 的線上實作：直接讀寫 Supabase（核心層 C 使用）。
// 不送 user_id、version、created_at、updated_at：前兩者由 RLS 預設值與觸發器處理，後兩者只由資料庫寫入。

import type { PostgrestError } from '@supabase/supabase-js'
import {
  RepoError,
  normalizeName,
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

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' })

function sortNodes(nodes: NodeMeta[]): NodeMeta[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

/** 把 Supabase 的錯誤轉成 RepoError（訊息可直接顯示） */
function toRepoError(error: PostgrestError, status: number): RepoError {
  if (status === 0 || !error.code) {
    return new RepoError('network', '無法連線到伺服器，請確認網路後再試。')
  }
  switch (error.code) {
    case '23505':
      return new RepoError('duplicate_name', '這個資料夾裡已經有相同名稱的項目（不分大小寫）。')
    case '23514':
      return new RepoError('invalid_name', '名稱不符合規則：1～100 字，不能包含 /、\\ 或 ..。')
    case '23503':
      return new RepoError('not_found', '上層資料夾不存在，可能已經被刪除。請重新整理後再試。')
    case 'PGRST116':
      return new RepoError('not_found', '找不到這個項目，可能已經被刪除。請重新整理後再試。')
    default:
      return new RepoError('unknown', `發生錯誤：${error.message}`)
  }
}

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

export const onlineRepo: Repo = {
  listChildren,
  getNode,
  createNode,
  updateNode,
  moveNode,
  deleteNode,
}
