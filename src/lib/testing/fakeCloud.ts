// 測試用的記憶體版雲端（sync.test.ts、trash.test.ts 共用），規則比照資料庫：
// version 由「資料庫」加 1、同層未刪除的名稱不分大小寫不可重複、上層必須存在（標記刪除的也算）。

import type { Cloud, CloudRow } from '../cloud.ts'
import { RepoError } from '../nodes.ts'

export function fakeCloud() {
  const rows = new Map<string, CloudRow>()
  /** 永久刪除的列（雲端的 purged_at 有值；CloudRow 不含這個欄位，另外記） */
  const purged = new Set<string>()
  /** Storage 裡的圖片檔：id → 檔案 */
  const files = new Map<string, Blob>()
  let clock = Date.parse('2026-11-25T00:00:00Z')
  const stamp = () => new Date((clock += 1000)).toISOString()
  const state = {
    online: true,
    /** 接下來幾次寫入：雲端寫入成功，但回應遺失（丟出連線錯誤） */
    dropResponses: 0,
    /** 修改一律失敗（模擬斷線以外的錯誤） */
    failUpdates: false,
    /** 每次寫入前執行（模擬推送期間使用者又修改） */
    beforeWrite: undefined as undefined | (() => Promise<void>),
    /** Storage 裡被刪掉的圖片檔 id */
    removedFiles: [] as string[],
    /** 上傳圖片檔的紀錄（id，重送的也算） */
    uploads: [] as string[],
    /** 上傳圖片檔一律失敗（斷線以外的錯誤，例如格式不對） */
    failUploads: false,
  }
  const clone = (row: CloudRow): CloudRow => ({ ...row })
  const check = () => {
    if (!state.online) throw new RepoError('network', '無法連線到伺服器，請確認網路後再試。')
  }
  const assertName = (parentId: string | null, name: string, exceptId?: string) => {
    for (const row of rows.values()) {
      if (!row.deleted_at && row.parent_id === parentId && row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase()) {
        throw new RepoError('duplicate_name', '這個資料夾裡已經有相同名稱的項目（不分大小寫）。')
      }
    }
  }
  // 外鍵只檢查列存在（標記刪除的也算），跟資料庫一樣
  const assertParent = (parentId: string | null) => {
    if (parentId && !rows.has(parentId)) throw new RepoError('not_found', '上層資料夾不存在。')
  }
  const respond = (row: CloudRow) => {
    if (state.dropResponses > 0) {
      state.dropResponses--
      throw new RepoError('network', '無法連線到伺服器，請確認網路後再試。')
    }
    return clone(row)
  }
  const beforeWrite = async () => {
    const hook = state.beforeWrite
    state.beforeWrite = undefined
    await hook?.()
  }

  const cloud: Cloud = {
    async pullSince(since) {
      check()
      return [...rows.values()]
        .filter((row) => !since || Date.parse(row.updated_at) >= Date.parse(since))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
        .map(clone)
    },
    async getRows(ids) {
      check()
      return ids.flatMap((id) => (rows.has(id) ? [clone(rows.get(id)!)] : []))
    },
    async insertIfAbsent(row) {
      check()
      await beforeWrite()
      if (rows.has(row.id)) return null
      assertName(row.parent_id, row.name)
      assertParent(row.parent_id)
      const time = stamp()
      const created: CloudRow = { ...row, version: 1, created_at: time, updated_at: time, deleted_at: null }
      rows.set(row.id, created)
      return respond(created)
    },
    async updateIfVersion(id, changes, version) {
      check()
      await beforeWrite()
      if (state.failUpdates) throw new RepoError('unknown', '發生錯誤：測試用的失敗')
      const row = rows.get(id)
      if (!row || row.version !== version) return null
      const { purged_at: purgedAt, ...fields } = changes
      const next: CloudRow = { ...row, ...fields }
      const restoring = row.deleted_at !== null && changes.deleted_at === null
      if (!next.deleted_at && (changes.name !== undefined || changes.parent_id !== undefined || restoring)) {
        assertName(next.parent_id, next.name, id)
      }
      if (changes.parent_id !== undefined) assertParent(next.parent_id)
      next.version = row.version + 1
      next.updated_at = stamp()
      rows.set(id, next)
      if (purgedAt === null) purged.delete(id)
      return respond(next)
    },
    async listTrash() {
      check()
      return [...rows.values()]
        .filter((row) => row.deleted_at && !purged.has(row.id))
        .sort((a, b) => b.deleted_at!.localeCompare(a.deleted_at!) || a.id.localeCompare(b.id))
        .map(({ content: _content, ...row }) => row)
    },
    async purge(ids) {
      check()
      const result: CloudRow[] = []
      for (const id of ids) {
        const row = rows.get(id)
        if (!row?.deleted_at || purged.has(id)) continue
        const next: CloudRow = { ...row, content: row.type === 'image' ? row.content : null, version: row.version + 1, updated_at: stamp() }
        rows.set(id, next)
        purged.add(id)
        result.push(clone(next))
      }
      return result
    },
    async removeImageIfUnused(fileId) {
      check()
      // 垃圾桶裡的（還能還原）也算用到
      const used = [...rows.values()].some((row) => !purged.has(row.id) && row.type === 'image' && row.content === fileId)
      if (used) return false
      state.removedFiles.push(fileId)
      files.delete(fileId)
      return true
    },
    // 已經存在時當成成功（跟 cloud.ts 一樣）；dropResponses 時檔案存進去了，但回應遺失
    async uploadImage(fileId, image) {
      check()
      if (state.failUploads) throw new RepoError('unknown', '僅支援 WebP、JPEG 格式的圖片。')
      state.uploads.push(fileId)
      if (!files.has(fileId)) files.set(fileId, image)
      if (state.dropResponses > 0) {
        state.dropResponses--
        throw new RepoError('network', '無法連線到伺服器，故沒有上傳圖片。')
      }
    },
  }

  /** 雲端上未刪除、名稱相符的列 */
  const live = (name: string) => [...rows.values()].find((row) => row.name === name && !row.deleted_at)
  return { cloud, rows, purged, files, state, stamp, live }
}
