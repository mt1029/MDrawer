// nodes 資料的型別、錯誤與名稱規則。repo.ts 與各個實作共用。

export type NodeType = 'folder' | 'note'

/** 樹狀清單需要的欄位（不含筆記內容） */
export interface NodeMeta {
  id: string
  parent_id: string | null
  type: NodeType
  name: string
  version: number
  created_at: string
  updated_at: string
}

/** 含筆記內容的完整資料 */
export interface TreeNode extends NodeMeta {
  content: string | null
}

export type RepoErrorKind =
  | 'duplicate_name' // 同一層已有同名項目
  | 'invalid_name' // 名稱不符合規則
  | 'invalid_move' // 移到自己、自己的子孫或不是資料夾的地方
  | 'not_found' // 找不到，或已被刪除
  | 'network' // 連不到伺服器
  | 'offline' // 離線中，這個操作需要網路（例如圖片）
  | 'conflict' // 編輯期間這篇被同步改過，這次的內容已另存為衝突副本
  | 'unknown'

/** repo 丟出的錯誤。message 是可以直接顯示給使用者的中文 */
export class RepoError extends Error {
  readonly kind: RepoErrorKind

  constructor(kind: RepoErrorKind, message: string) {
    super(message)
    this.name = 'RepoError'
    this.kind = kind
  }
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' })

/** 資料夾在前、再依名稱排序（數字依大小，不分大小寫）。直接排序傳入的陣列 */
export function sortNodes<T extends NodeMeta>(nodes: T[]): T[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

export const MAX_NAME_LENGTH = 100

/** 統一 Unicode 組合方式並去掉前後空白，避免看起來一樣的名稱被當成不同 */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim()
}

/** 與資料庫的 check 限制相同。回傳錯誤訊息，沒問題時回傳 null */
export function validateName(name: string): string | null {
  if (name.length === 0) return '名稱不能是空的。'
  // 用 code point 計算長度，與 PostgreSQL 的 char_length 一致
  if ([...name].length > MAX_NAME_LENGTH) return `名稱最多 ${MAX_NAME_LENGTH} 個字。`
  if (/[/\\]/.test(name)) return '名稱不能包含 / 或 \\。'
  if (name.includes('..')) return '名稱不能包含連續兩個點（..）。'
  return null
}

/** 把名稱截短到 max 個字（以 code point 計算，與資料庫一致） */
function truncate(name: string, max: number): string {
  const chars = [...name]
  return chars.length <= max ? name : chars.slice(0, max).join('').trimEnd()
}

/** 撞名時的新名稱：「名稱 (2)」。超過長度上限時截短原名 */
export function numberedName(name: string, n: number): string {
  const suffix = ` (${n})`
  return truncate(name, MAX_NAME_LENGTH - suffix.length) + suffix
}

/** 衝突副本的名稱：「名稱（衝突副本 2026-11-25 14:30）」（spec 第 6 節） */
export function conflictCopyName(name: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const suffix = `（衝突副本 ${stamp}）`
  return truncate(name, MAX_NAME_LENGTH - suffix.length) + suffix
}
