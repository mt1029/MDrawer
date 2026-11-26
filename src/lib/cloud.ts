// 同步用的雲端操作（離線 L2，spec 第 6 節），只給 sync.ts 使用，UI 不直接呼叫。
// 傳入 Supabase 用戶端來建立，不依賴 Vite 的環境變數，
// 所以 scripts/sync-check.mjs 可以用 Node 對真正的 Supabase 執行同一份程式。
//
// 不送 user_id、version、created_at、updated_at：前者是資料表預設值，其餘只由觸發器寫入。

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { IMAGE_FILE_ID, MAX_NAME_LENGTH, RepoError, type NodeType, type TreeNode } from './nodes.ts'
import { strings } from '../strings.ts'

/** 雲端的一列，包含已標記刪除的 */
export interface CloudRow extends TreeNode {
  deleted_at: string | null
}

/** 新增時送出的欄位 */
export interface NewRow {
  id: string
  parent_id: string | null
  type: NodeType
  name: string
  content: string | null
}

export type RowChanges = Partial<Pick<CloudRow, 'name' | 'content' | 'parent_id' | 'deleted_at'>>

export interface Cloud {
  /** updated_at >= since 的所有列（含已刪除），依 updated_at、id 排序。since 為 null 時讀全部 */
  pullSince(since: string | null): Promise<CloudRow[]>
  /** 依 id 讀取（含已刪除）。不存在的 id 不會出現在結果裡 */
  getRows(ids: string[]): Promise<CloudRow[]>
  /** 新增一列；id 已經存在時不做任何事並回傳 null（之前送過、但沒收到回應） */
  insertIfAbsent(row: NewRow): Promise<CloudRow | null>
  /** 雲端的 version 等於 version 才更新，回傳更新後的列；不相等（被別台改過）回傳 null */
  updateIfVersion(id: string, changes: RowChanges, version: number): Promise<CloudRow | null>
  /**
   * 圖片項目刪除後，刪掉 Storage 裡的圖片檔；還有其他沒刪除的圖片項目（複製出來的）
   * 用到同一個檔案時保留。回傳是否刪掉了
   */
  removeImageIfUnused(fileId: string): Promise<boolean>
}

const IMAGE_BUCKET = 'images'

const SYNC_COLUMNS = 'id, parent_id, type, name, content, version, created_at, updated_at, deleted_at'

// 一次讀取的筆數。Supabase 預設最多回傳 1000 筆
const PAGE_SIZE = 1000
// 一次查詢的 id 數，太多會讓網址過長
const BATCH_SIZE = 100

/** 把 Supabase 的錯誤轉成 RepoError（訊息可直接顯示） */
export function toRepoError(error: PostgrestError, status: number): RepoError {
  if (status === 0 || !error.code) {
    return new RepoError('network', strings.errors.network)
  }
  switch (error.code) {
    case '23505':
      return new RepoError('duplicate_name', strings.errors.nodes.duplicateName)
    case '23514':
      return new RepoError('invalid_name', strings.errors.names.invalid(MAX_NAME_LENGTH))
    case '23503':
      return new RepoError('not_found', strings.errors.nodes.parentNotFound)
    case 'PGRST116':
      return new RepoError('not_found', strings.errors.nodes.notFound)
    default:
      return new RepoError('unknown', strings.errors.unknown(error.message))
  }
}

export function createCloud(client: SupabaseClient, options: { pageSize?: number } = {}): Cloud {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const nodes = () => client.from('nodes')

  return {
    async pullSince(since) {
      const rows: CloudRow[] = []
      let last: CloudRow | null = null
      for (;;) {
        let query = nodes().select(SYNC_COLUMNS).order('updated_at').order('id').limit(pageSize)
        if (last) {
          // 從上一頁最後一筆之後接著讀（時間相同時比 id）。不用 offset，讀取期間有新的修改也不會漏掉或錯位。
          // 時間字串含 : . + 等 PostgREST 的保留字元，要用雙引號包起來
          const at = `"${last.updated_at}"`
          query = query.or(`updated_at.gt.${at},and(updated_at.eq.${at},id.gt.${last.id})`)
        } else if (since) {
          query = query.gte('updated_at', since)
        }
        const { data, error, status } = await query
        if (error) throw toRepoError(error, status)
        const page = data as CloudRow[]
        rows.push(...page)
        if (page.length < pageSize) return rows
        last = page[page.length - 1]
      }
    },

    async getRows(ids) {
      const rows: CloudRow[] = []
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const { data, error, status } = await nodes()
          .select(SYNC_COLUMNS)
          .in('id', ids.slice(i, i + BATCH_SIZE))
        if (error) throw toRepoError(error, status)
        rows.push(...(data as CloudRow[]))
      }
      return rows
    },

    async insertIfAbsent(row) {
      // spec 第 6 節：upsert 搭配 ignoreDuplicates，id 已存在時什麼都不做，重送也安全。
      // 名稱重複（同層唯一索引）仍會回報 23505
      const { data, error, status } = await nodes()
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
        .select(SYNC_COLUMNS)
      if (error) throw toRepoError(error, status)
      return (data as CloudRow[])[0] ?? null
    },

    async updateIfVersion(id, changes, version) {
      // spec 第 6 節：update ... where id = ? and version = base_version，並要求回傳資料列。
      // 沒有回傳代表雲端版本比較新
      const { data, error, status } = await nodes()
        .update(changes)
        .eq('id', id)
        .eq('version', version)
        .select(SYNC_COLUMNS)
      if (error) throw toRepoError(error, status)
      return (data as CloudRow[])[0] ?? null
    },

    async removeImageIfUnused(fileId) {
      if (!IMAGE_FILE_ID.test(fileId)) return false
      const images = await nodes()
        .select('id')
        .eq('type', 'image')
        .eq('content', fileId)
        .is('deleted_at', null)
        .limit(1)
      if (images.error) throw toRepoError(images.error, images.status)
      if (images.data.length > 0) return false

      const { data } = await client.auth.getSession()
      const userId = data.session?.user.id
      if (!userId) return false
      const removed = await client.storage.from(IMAGE_BUCKET).remove([`${userId}/${fileId}`])
      if (removed.error) throw new RepoError('network', strings.errors.network)
      return removed.data.length > 0
    },
  }
}
