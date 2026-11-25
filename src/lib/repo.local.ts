// repo 的本機實作（離線 L2）：讀寫都在這台裝置的 IndexedDB 完成，修改同時放進待同步佇列，
// 連線時由 sync.ts 推送到雲端。名稱規則、同層不可同名、移動不能形成循環，先在本機檢查一次；
// 推送時資料庫會再檢查（例如另一台裝置剛好建了同名的項目），由 sync.ts 處理。
//
// version、created_at、updated_at 不會送到資料庫（CLAUDE.md 規則）。本機新增的項目 version 為 0，
// 時間只用來在這台裝置上顯示，推送後換成資料庫寫入的值。

import {
  ROOT_KEY,
  addConflictCopy,
  nameTaken,
  nextSeq,
  recordCreate,
  recordUpdate,
  snapshot,
  toLocal,
  toMeta,
  toTree,
  type DbHandle,
  type Field,
  type WriteTx,
} from './localDb.ts'
import { RepoError, normalizeName, sortNodes, validateName, type NodeMeta } from './nodes.ts'
import type { Repo } from './repo.ts'

export interface LocalRepoOptions {
  /** 每次寫入本機之後呼叫（排程推送、更新待同步數量） */
  onWrite?: () => void
  now?: () => Date
}

const DUPLICATE_MESSAGE = '這個資料夾裡已經有相同名稱的項目（不分大小寫）。'
const NOT_FOUND_MESSAGE = '找不到這個項目，可能已經被刪除。請重新整理後再試。'

function checkName(raw: string): string {
  const name = normalizeName(raw)
  const problem = validateName(name)
  if (problem) throw new RepoError('invalid_name', problem)
  return name
}

function offline(message: string): Promise<never> {
  return Promise.reject(new RepoError('offline', message))
}

export function createLocalRepo(db: DbHandle, options: LocalRepoOptions = {}): Repo {
  const now = options.now ?? (() => new Date())

  /** 在同一個交易裡檢查並寫入；檢查失敗就放棄整個交易，不會留下寫一半的資料 */
  async function write<T>(work: (tx: WriteTx) => Promise<T>): Promise<T> {
    const tx = (await db()).transaction(['nodes', 'pending'], 'readwrite')
    tx.done.catch(() => undefined) // 放棄交易時 done 會 reject，錯誤已由下面處理
    try {
      const result = await work(tx)
      await tx.done
      options.onWrite?.()
      return result
    } catch (err) {
      try {
        tx.abort()
      } catch {
        // 交易已經結束
      }
      throw err
    }
  }

  /** 上層必須是本機存在的資料夾；回傳索引用的 key */
  async function parentKeyOf(tx: WriteTx, parentId: string | null): Promise<string> {
    if (!parentId) return ROOT_KEY
    const parent = await tx.objectStore('nodes').get(parentId)
    if (!parent) throw new RepoError('not_found', '上層資料夾不存在，可能已經被刪除。請重新整理後再試。')
    if (parent.type !== 'folder') throw new RepoError('invalid_move', '只能放在資料夾裡。')
    return parentId
  }

  return {
    async listChildren(parentId) {
      const rows = await (await db()).getAllFromIndex('nodes', 'by_parent', parentId ?? ROOT_KEY)
      return sortNodes(rows.map(toMeta))
    },

    async getNode(id) {
      const row = await (await db()).get('nodes', id)
      return row ? toTree(row) : null
    },

    async listAll() {
      return (await (await db()).getAll('nodes')).map(toTree)
    },

    async createNode(input) {
      const name = checkName(input.name)
      return write(async (tx) => {
        const parentKey = await parentKeyOf(tx, input.parentId)
        if (await nameTaken(tx, parentKey, name)) throw new RepoError('duplicate_name', DUPLICATE_MESSAGE)
        const time = now().toISOString()
        const node = toLocal({
          id: crypto.randomUUID(),
          parent_id: input.parentId,
          type: input.type,
          name,
          content: input.type === 'note' ? (input.content ?? '') : null,
          version: 0,
          created_at: time,
          updated_at: time,
        })
        await recordCreate(tx, node)
        return toMeta(node)
      })
    },

    async updateNode(id, patch) {
      const name = patch.name !== undefined ? checkName(patch.name) : undefined
      const result = await write(async (tx): Promise<{ node: NodeMeta } | { conflictCopy: string }> => {
        const nodes = tx.objectStore('nodes')
        const node = await nodes.get(id)
        if (!node) throw new RepoError('not_found', NOT_FOUND_MESSAGE)

        // 編輯器載入之後，這篇被同步改成別台裝置的內容：不要直接蓋掉，
        // 這次的內容另存為衝突副本，原筆記保留同步來的版本（spec 第 6 節衝突處理）
        if (patch.content !== undefined && patch.baseContent !== undefined && node.content !== patch.baseContent) {
          const copy = await addConflictCopy(tx, node.parent_id, node.name, patch.content, now())
          return { conflictCopy: copy.name }
        }

        const next = { ...node }
        const fields: Field[] = []
        if (name !== undefined && name !== node.name) {
          if (await nameTaken(tx, node.parent_key, name, id)) throw new RepoError('duplicate_name', DUPLICATE_MESSAGE)
          next.name = name
          fields.push('name')
        }
        if (patch.content !== undefined && patch.content !== node.content) {
          next.content = patch.content
          fields.push('content')
        }
        if (fields.length === 0) return { node: toMeta(node) }
        next.updated_at = now().toISOString()
        await nodes.put(next)
        await recordUpdate(tx, node, fields)
        return { node: toMeta(next) }
      })
      if ('conflictCopy' in result) {
        throw new RepoError(
          'conflict',
          `這篇筆記剛同步到其他裝置的修改。為了不蓋掉它，你這次的內容另存為「${result.conflictCopy}」。`,
        )
      }
      return result.node
    },

    async moveNode(id, newParentId) {
      return write(async (tx) => {
        const nodes = tx.objectStore('nodes')
        const node = await nodes.get(id)
        if (!node) throw new RepoError('not_found', NOT_FOUND_MESSAGE)

        // 從目標往上找到根目錄，途中不能遇到自己（不能移到自己或自己的子孫底下）
        const visited = new Set<string>()
        for (let current = newParentId, isTarget = true; current; isTarget = false) {
          if (current === id) throw new RepoError('invalid_move', '不能移到自己或自己底下的資料夾。')
          if (visited.has(current)) throw new RepoError('invalid_move', '資料夾結構出現循環，請重新整理後再試。')
          visited.add(current)
          const row = await nodes.get(current)
          if (!row) throw new RepoError('not_found', '目標資料夾不存在，可能已經被刪除。')
          if (isTarget && row.type !== 'folder') throw new RepoError('invalid_move', '只能移到資料夾裡。')
          current = row.parent_id
        }

        if (node.parent_id === newParentId) return toMeta(node)
        const parentKey = newParentId ?? ROOT_KEY
        if (await nameTaken(tx, parentKey, node.name, id)) {
          throw new RepoError('duplicate_name', '目標資料夾裡已經有相同名稱的項目（不分大小寫）。')
        }
        const next = { ...node, parent_id: newParentId, parent_key: parentKey, updated_at: now().toISOString() }
        await nodes.put(next)
        await recordUpdate(tx, node, ['parent_id'])
        return toMeta(next)
      })
    },

    async deleteNode(id) {
      await write(async (tx) => {
        const nodes = tx.objectStore('nodes')
        const pending = tx.objectStore('pending')
        if (!(await nodes.get(id))) throw new RepoError('not_found', NOT_FOUND_MESSAGE)

        // 找出這個項目與所有子孫
        const ids = [id]
        const seen = new Set(ids)
        for (let i = 0; i < ids.length; i++) {
          for (const child of await nodes.index('by_parent').getAllKeys(ids[i])) {
            if (!seen.has(child)) {
              seen.add(child)
              ids.push(child)
            }
          }
        }

        for (const nodeId of ids) {
          const node = (await nodes.get(nodeId))!
          const change = await pending.get(nodeId)
          await nodes.delete(nodeId)
          // 還沒推送過的新項目，雲端沒有，直接拿掉
          if (change?.op === 'create') {
            await pending.delete(nodeId)
            continue
          }
          await pending.put({
            id: nodeId,
            op: 'delete',
            base: change?.base ?? snapshot(node),
            fields: [],
            rev: (change?.rev ?? 0) + 1,
            seq: nextSeq(),
          })
        }
      })
    },

    // 圖片只存在雲端：連線時由 mirror.ts 改用線上版，這裡只處理離線
    uploadImage: () => offline('離線時無法上傳圖片。'),
    getImageUrls: () => offline('離線時無法載入圖片。'),
    downloadImage: () => offline('離線時無法下載圖片。'),
  }
}
