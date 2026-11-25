// repo 的本機實作：讀寫瀏覽器的 IndexedDB（離線 L1、L2 使用）。
// L1 只能讀：連線時由 mirror.ts 把雲端資料存一份進來，斷線時 UI 改讀這裡；
// 新增、修改、刪除一律回絕，等 L2 再加上待同步佇列。

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { RepoError, sortNodes, type NodeMeta, type TreeNode } from './nodes.ts'
import type { Repo } from './repo.ts'

const DB_NAME = 'mdrawer'
const DB_VERSION = 1
// IndexedDB 的索引不收 null，根目錄的項目改用這個值
const ROOT_KEY = 'root'

/** 本機副本屬於哪個帳號，以及最後一次從雲端整批存下來的時間 */
export interface LocalOwner {
  userId: string
  email: string
  /** ISO 時間字串（這台裝置的時間，只用來顯示） */
  syncedAt: string
}

interface LocalNode extends TreeNode {
  parent_key: string
}

interface LocalSchema extends DBSchema {
  nodes: { key: string; value: LocalNode; indexes: { by_parent: string } }
  meta: { key: string; value: LocalOwner }
}

let dbPromise: Promise<IDBPDatabase<LocalSchema>> | null = null

function db(): Promise<IDBPDatabase<LocalSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<LocalSchema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const nodes = database.createObjectStore('nodes', { keyPath: 'id' })
        nodes.createIndex('by_parent', 'parent_key')
        database.createObjectStore('meta')
      },
      // 其他分頁要升級資料庫（例如之後的 L2 版本）時先關閉，避免卡住對方
      blocking(_current, _blocked, event) {
        ;(event.target as IDBDatabase).close()
        dbPromise = null
      },
      terminated() {
        dbPromise = null
      },
    })
    // 開不起來（例如瀏覽器封鎖網站資料）時，下次再試
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

function toLocal(node: TreeNode): LocalNode {
  return { ...node, parent_key: node.parent_id ?? ROOT_KEY }
}

function toTree(row: LocalNode): TreeNode {
  const { parent_key: _parentKey, ...node } = row
  return node
}

function toMeta(row: LocalNode): NodeMeta {
  const { parent_key: _parentKey, content: _content, ...meta } = row
  return meta
}

const READ_ONLY_MESSAGE = '離線中，僅能閱讀。恢復連線後才能新增、修改、移動或刪除。'

function refuse(message: string): Promise<never> {
  return Promise.reject(new RepoError('offline', message))
}

/** 讀取本機副本；寫入一律回絕（L1） */
export const localRepo: Repo = {
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
  createNode: () => refuse(READ_ONLY_MESSAGE),
  updateNode: () => refuse(READ_ONLY_MESSAGE),
  moveNode: () => refuse(READ_ONLY_MESSAGE),
  deleteNode: () => refuse(READ_ONLY_MESSAGE),
  uploadImage: () => refuse('離線時無法上傳圖片。'),
  getImageUrls: () => refuse('離線時無法載入圖片。'),
  downloadImage: () => refuse('離線時無法下載圖片。'),
}

/** 回傳 false 代表這次寫入已經作廢（期間登出或換了帳號），不要寫 */
export type StillValid = () => boolean

/** 維護本機副本用的操作，只給 mirror.ts 使用 */
export const localStore = {
  async getOwner(): Promise<LocalOwner | null> {
    return (await (await db()).get('meta', 'owner')) ?? null
  },

  /**
   * 用雲端的完整資料取代本機副本，並記下擁有者。
   * keep 裡的 id 是下載期間這台裝置改過的項目：保留本機現有的版本，不被下載到的舊資料蓋掉；
   * 其中已經在本機刪掉的，連同下載結果裡的子孫都不加回來。
   */
  async replaceAll(owner: LocalOwner, nodes: TreeNode[], keep: Set<string>, stillValid: StillValid): Promise<boolean> {
    const database = await db()
    if (!stillValid()) return false
    // 同一個交易裡完成：中途失敗時本機副本維持原樣，不會只剩一半
    const tx = database.transaction(['nodes', 'meta'], 'readwrite')
    const store = tx.objectStore('nodes')
    const keepIds = [...keep]
    const kept = (await Promise.all(keepIds.map((id) => store.get(id)))).filter((row) => row !== undefined)

    const skip = new Set(keepIds)
    const removed = keepIds.filter((id) => !kept.some((row) => row.id === id))
    if (removed.length > 0) {
      const childrenOf = new Map<string, string[]>()
      for (const node of nodes) {
        if (!node.parent_id) continue
        childrenOf.set(node.parent_id, [...(childrenOf.get(node.parent_id) ?? []), node.id])
      }
      for (const frontier = [...removed]; frontier.length > 0; ) {
        for (const child of childrenOf.get(frontier.pop()!) ?? []) {
          if (!skip.has(child)) {
            skip.add(child)
            frontier.push(child)
          }
        }
      }
    }

    await store.clear()
    await Promise.all([
      ...nodes.filter((node) => !skip.has(node.id)).map((node) => store.put(toLocal(node))),
      ...kept.map((row) => store.put(row)),
      tx.objectStore('meta').put(owner, 'owner'),
    ])
    await tx.done
    return true
  },

  /**
   * 寫入一筆雲端剛回傳的資料。content 為 undefined 代表不知道內容（例如只改名），保留本機原有的；
   * 本機沒有這篇筆記、又不知道內容時不寫，等下次整批下載。
   */
  async putNode(meta: NodeMeta, content: string | null | undefined, stillValid: StillValid): Promise<void> {
    const database = await db()
    if (!stillValid()) return
    const tx = database.transaction('nodes', 'readwrite')
    const existing = await tx.store.get(meta.id)
    if (existing || content !== undefined || meta.type === 'folder') {
      const known = content !== undefined ? content : (existing?.content ?? null)
      await tx.store.put(toLocal({ ...meta, content: meta.type === 'note' ? known : null }))
    }
    await tx.done
  },

  /** 刪除一筆與它所有的子孫，回傳刪掉的 id */
  async removeTree(id: string, stillValid: StillValid): Promise<string[]> {
    const database = await db()
    if (!stillValid()) return []
    const tx = database.transaction('nodes', 'readwrite')
    const index = tx.store.index('by_parent')
    const seen = new Set([id])
    for (let frontier = [id]; frontier.length > 0; ) {
      const next: string[] = []
      for (const parent of frontier) {
        for (const child of await index.getAllKeys(parent)) {
          if (!seen.has(child)) {
            seen.add(child)
            next.push(child)
          }
        }
      }
      frontier = next
    }
    await Promise.all([...seen].map((nodeId) => tx.store.delete(nodeId)))
    await tx.done
    return [...seen]
  },

  /** 清空本機副本（登出、換帳號時） */
  async clear(): Promise<void> {
    const tx = (await db()).transaction(['nodes', 'meta'], 'readwrite')
    await Promise.all([tx.objectStore('nodes').clear(), tx.objectStore('meta').clear(), tx.done])
  },
}

export type LocalStore = typeof localStore
