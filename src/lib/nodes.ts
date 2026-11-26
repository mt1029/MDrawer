// nodes 資料的型別、錯誤與名稱規則。repo.ts 與各個實作共用。

import { strings } from '../strings.ts'

/** 資料夾、筆記、圖片（圖片的 content 是 Storage 裡圖片檔的 uuid） */
export type NodeType = 'folder' | 'note' | 'image'

/** 圖片檔的 uuid（Storage 的路徑是「使用者 id/uuid」），與資料庫的 nodes_image_file 限制相同 */
export const IMAGE_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 圖片的副檔名（numberedName 撞名時把編號放在副檔名前面） */
const IMAGE_EXTENSION = /\.(webp|jpe?g|png|gif|avif)$/i

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

/** 比較兩個名稱（數字依大小，不分大小寫），跟資料夾樹的排序一樣 */
export const compareNames = (a: string, b: string): number => collator.compare(a, b)

/**
 * 所在的資料夾路徑，例如「/課程/第一週/」，最上層為「/」。只到資料夾，結尾的 / 表示這是資料夾。
 * find 用 id 找資料夾；找不到（還沒載入、剛被別台裝置移走）或出現循環時，那一段以前用「…」代替
 */
export function folderPath(
  parentId: string | null,
  find: (id: string) => Pick<NodeMeta, 'name' | 'parent_id'> | undefined,
): string {
  const names: string[] = []
  const seen = new Set<string>()
  for (let id = parentId; id; ) {
    const parent = find(id)
    if (!parent || seen.has(id)) {
      names.unshift('…')
      break
    }
    seen.add(id)
    names.unshift(parent.name)
    id = parent.parent_id
  }
  return names.length > 0 ? `/${names.join('/')}/` : '/'
}

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
  if (name.length === 0) return strings.errors.names.empty
  // 用 code point 計算長度，與 PostgreSQL 的 char_length 一致
  if ([...name].length > MAX_NAME_LENGTH) return strings.errors.names.tooLong(MAX_NAME_LENGTH)
  if (/[/\\]/.test(name)) return strings.errors.names.slash
  if (name.includes('..')) return strings.errors.names.dots
  return null
}

/** 把名稱截短到 max 個字（以 code point 計算，與資料庫一致） */
function truncate(name: string, max: number): string {
  const chars = [...name]
  return chars.length <= max ? name : chars.slice(0, max).join('').trimEnd()
}

/**
 * 撞名時的新名稱：「名稱 (2)」；圖片的編號放在副檔名前面（「照片 (2).webp」），副檔名才不會跑掉。
 * 超過長度上限時截短原名
 */
export function numberedName(name: string, n: number): string {
  const extension = IMAGE_EXTENSION.exec(name)?.[0] ?? ''
  const suffix = ` (${n})${extension}`
  return truncate(name.slice(0, name.length - extension.length), MAX_NAME_LENGTH - [...suffix].length) + suffix
}

/** 上傳的圖片的名稱：原本的檔名換成壓縮後的副檔名（例如 IMG_0001.HEIC → IMG_0001.jpg），不符合名稱規則的字換掉 */
export function imageFileName(originalName: string, format: 'image/webp' | 'image/jpeg'): string {
  const base = normalizeName(originalName.replace(/\.[^.]*$/, ''))
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/\.$/, '')
  const extension = format === 'image/jpeg' ? '.jpg' : '.webp'
  return truncate(base || 'image', MAX_NAME_LENGTH - extension.length) + extension
}

/** 衝突副本的名稱：「名稱（衝突副本 2026-11-25 14:30）」（spec 第 6 節） */
export function conflictCopyName(name: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const suffix = strings.errors.names.conflictCopySuffix(stamp)
  return truncate(name, MAX_NAME_LENGTH - suffix.length) + suffix
}
