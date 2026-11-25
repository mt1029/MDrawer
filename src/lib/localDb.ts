// 這台裝置上的本機資料庫（IndexedDB）。L2 起畫面的讀寫都先經過這裡，再由 sync.ts 與雲端同步。
//
//   nodes    每個未刪除項目在這台裝置上目前的樣子（包含還沒同步的修改）
//   pending  待同步佇列：每個項目一筆，記錄要新增、改了哪些欄位或要刪除，以及修改前的雲端版本
//   meta     owner：副本屬於哪個帳號；cursor：已經拉取到雲端的哪個時間

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { conflictCopyName, numberedName, type NodeMeta, type TreeNode } from './nodes.ts'

export const DB_NAME = 'mdrawer'
const DB_VERSION = 2

// IndexedDB 的索引不收 null，根目錄的項目改用這個值
export const ROOT_KEY = 'root'

/** 本機副本屬於哪個帳號 */
export interface LocalOwner {
  userId: string
  email: string
  /** 最後一次同步完成的時間（ISO 字串，這台裝置的時間，只用來顯示） */
  syncedAt: string
  /** 登入被強制失效時還有未同步的修改：保留資料，等同一個帳號重新登入（不是自己按登出） */
  signedOut?: boolean
}

export interface LocalNode extends TreeNode {
  parent_key: string
}

/** 會在本機修改、需要推送的欄位 */
export type Field = 'name' | 'content' | 'parent_id'
export const FIELDS: readonly Field[] = ['name', 'content', 'parent_id']

/** 修改前的雲端版本：推送時用 version 偵測衝突，用欄位值判斷雲端改了什麼 */
export interface Snapshot {
  version: number
  name: string
  parent_id: string | null
  content: string | null
}

/** 待同步佇列的一筆。同一個項目的多次修改合併成一筆 */
export interface PendingChange {
  id: string
  /** create：雲端還沒有；update：改了 fields；delete：要標記刪除 */
  op: 'create' | 'update' | 'delete'
  /** 修改前的雲端版本；create 為 null */
  base: Snapshot | null
  /** update 時本機改過的欄位 */
  fields: Field[]
  /** 每次本機修改加 1。推送完成時若不同，代表推送期間又改過，不能直接清掉 */
  rev: number
  /** 最後一次修改的順序，推送時照這個順序 */
  seq: number
  /** 上次推送失敗的原因（不含斷線），下次同步會再試 */
  error?: string
}

interface Schema extends DBSchema {
  nodes: { key: string; value: LocalNode; indexes: { by_parent: string } }
  pending: { key: string; value: PendingChange }
  meta: { key: string; value: LocalOwner | string }
}

export type LocalDb = IDBPDatabase<Schema>
/** 同時改 nodes 與 pending 的交易：本機資料與待同步佇列一起寫入，不會只寫一半 */
export type WriteTx = IDBPTransaction<Schema, ('nodes' | 'pending')[], 'readwrite'>

/** 取得資料庫連線；第一次呼叫時開啟，被其他分頁要求升級或連線中斷時下次重開 */
export type DbHandle = () => Promise<LocalDb>

export function createDbHandle(name = DB_NAME): DbHandle {
  let promise: Promise<LocalDb> | null = null
  return () => {
    if (!promise) {
      promise = openDB<Schema>(name, DB_VERSION, {
        upgrade(database, oldVersion) {
          // L1（版本 1）的副本照樣保留，只加上待同步佇列
          if (oldVersion < 1) {
            database.createObjectStore('nodes', { keyPath: 'id' }).createIndex('by_parent', 'parent_key')
            database.createObjectStore('meta')
          }
          if (oldVersion < 2) database.createObjectStore('pending', { keyPath: 'id' })
        },
        // 其他分頁載入了新版、要升級資料庫時先關閉，避免卡住對方
        blocking(_current, _blocked, event) {
          ;(event.target as IDBDatabase).close()
          promise = null
        },
        terminated() {
          promise = null
        },
      })
      // 開不起來（例如瀏覽器封鎖網站資料）時，下次再試
      promise.catch(() => {
        promise = null
      })
    }
    return promise
  }
}

export function toLocal(node: TreeNode): LocalNode {
  const { id, parent_id, type, name, content, version, created_at, updated_at } = node
  return { id, parent_id, type, name, content, version, created_at, updated_at, parent_key: parent_id ?? ROOT_KEY }
}

export function toTree(row: LocalNode): TreeNode {
  const { parent_key: _parentKey, ...node } = row
  return node
}

export function toMeta(row: LocalNode): NodeMeta {
  const { parent_key: _parentKey, content: _content, ...meta } = row
  return meta
}

export function snapshot(node: TreeNode): Snapshot {
  return { version: node.version, name: node.name, parent_id: node.parent_id, content: node.content }
}

export async function getOwner(db: LocalDb): Promise<LocalOwner | null> {
  return ((await db.get('meta', 'owner')) as LocalOwner | undefined) ?? null
}

export async function getCursor(db: LocalDb): Promise<string | null> {
  return ((await db.get('meta', 'cursor')) as string | undefined) ?? null
}

export async function countPending(db: LocalDb): Promise<number> {
  return db.count('pending')
}

/** 清空本機副本與待同步佇列（登出、換帳號時） */
export async function clearAll(db: LocalDb): Promise<void> {
  const tx = db.transaction(['nodes', 'pending', 'meta'], 'readwrite')
  await Promise.all([
    tx.objectStore('nodes').clear(),
    tx.objectStore('pending').clear(),
    tx.objectStore('meta').clear(),
    tx.done,
  ])
}

let lastSeq = 0
/** 遞增的順序號碼（跨重新整理也會比之前的大） */
export function nextSeq(): number {
  lastSeq = Math.max(Date.now(), lastSeq + 1)
  return lastSeq
}

// ── 寫入本機並記進待同步佇列（repo.local.ts 與 sync.ts 共用）────────────

/** 新項目：寫入本機，佇列記一筆 create */
export async function recordCreate(tx: WriteTx, node: LocalNode): Promise<void> {
  await tx.objectStore('nodes').put(node)
  await tx.objectStore('pending').put({ id: node.id, op: 'create', base: null, fields: [], rev: 1, seq: nextSeq() })
}

/**
 * 既有項目改了 fields：before 是修改前的本機資料。
 * 第一次修改時記下修改前的雲端版本（base）；之後的修改合併到同一筆，base 不變。
 */
export async function recordUpdate(tx: WriteTx, before: LocalNode, fields: Field[]): Promise<void> {
  const store = tx.objectStore('pending')
  const change = await store.get(before.id)
  if (!change) {
    await store.put({ id: before.id, op: 'update', base: snapshot(before), fields, rev: 1, seq: nextSeq() })
  } else if (change.op === 'create') {
    // 雲端還沒有這個項目，推送時會整筆新增，不必記欄位
    await store.put({ ...change, rev: change.rev + 1 })
  } else {
    const merged = [...new Set([...change.fields, ...fields])]
    await store.put({ ...change, op: 'update', fields: merged, rev: change.rev + 1, seq: nextSeq(), error: undefined })
  }
}

/** 同一層裡（不分大小寫）是否已有這個名稱 */
export async function nameTaken(tx: WriteTx, parentKey: string, name: string, exceptId?: string): Promise<boolean> {
  const siblings = await tx.objectStore('nodes').index('by_parent').getAll(parentKey)
  const lower = name.toLowerCase()
  return siblings.some((node) => node.id !== exceptId && node.name.toLowerCase() === lower)
}

/** 同一層沒有重複的名稱：重複時加上「 (2)」「 (3)」… */
export async function uniqueName(tx: WriteTx, parentKey: string, name: string): Promise<string> {
  let candidate = name
  for (let n = 2; await nameTaken(tx, parentKey, candidate); n++) candidate = numberedName(name, n)
  return candidate
}

/** 衝突副本：在同一個資料夾新增一篇筆記，放進待同步佇列 */
export async function addConflictCopy(
  tx: WriteTx,
  parentId: string | null,
  originalName: string,
  content: string | null,
  now: Date,
): Promise<NodeMeta> {
  const parentKey = parentId ?? ROOT_KEY
  const name = await uniqueName(tx, parentKey, conflictCopyName(originalName, now))
  // 時間只用來在這台裝置顯示，不會送到資料庫；推送後換成資料庫寫入的值
  const time = now.toISOString()
  const copy = toLocal({
    id: crypto.randomUUID(),
    parent_id: parentId,
    type: 'note',
    name,
    content: content ?? '',
    version: 0,
    created_at: time,
    updated_at: time,
  })
  await recordCreate(tx, copy)
  return toMeta(copy)
}
