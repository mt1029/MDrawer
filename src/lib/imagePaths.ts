// 筆記用相對路徑引用資料夾裡的圖片（圖片放進資料夾第 2 步）：
//   ![](架構圖.webp)          同一個資料夾
//   ![](圖/架構圖.webp)       子資料夾
//   ![](../共用/架構圖.webp)  上一層的其他資料夾
//   ![](/課程/架構圖.webp)    從最上層開始
// 跟一般的檔案系統一樣：圖片改名或移動後，連結不會自動更新（spec 第 8 節已知限制）。
// 純函式，資料由呼叫的地方用 repo.listAll() 取得後傳進來。

import type { NodeMeta, TreeNode } from './nodes.ts'

type Node = Pick<NodeMeta, 'id' | 'parent_id' | 'type' | 'name'> & Partial<Pick<TreeNode, 'content'>>

/** 不是網址（https:、img:、data: 等）、不是 // 開頭、不是 # 的圖片位址，當成資料夾裡的路徑 */
export function isLocalImagePath(src: string): boolean {
  return src !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//') && !src.startsWith('#')
}

/** markdown-it 會把連結裡的中文、空白編碼（%E6%9E%B6…），換回原本的字 */
export function decodeImagePath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

export interface PathIndex<T extends Node = Node> {
  byId: Map<string, T>
  /** 上層資料夾 id（最上層為 null）→ 小寫名稱 → 項目 */
  children: Map<string | null, Map<string, T>>
}

const key = (name: string) => name.normalize('NFC').toLowerCase()

export function createPathIndex<T extends Node>(nodes: T[]): PathIndex<T> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const children = new Map<string | null, Map<string, T>>()
  for (const node of nodes) {
    const list = children.get(node.parent_id) ?? new Map<string, T>()
    list.set(key(node.name), node)
    children.set(node.parent_id, list)
  }
  return { byId, children }
}

/**
 * 從 folderId 資料夾（null 為最上層）出發，找 path 指到的圖片項目；找不到、或指到的不是圖片時回傳 null。
 * 名稱不分大小寫（同一層本來就不能只差大小寫）
 */
export function resolveImagePath<T extends Node>(index: PathIndex<T>, folderId: string | null, path: string): T | null {
  const segments = path.split('/')
  let current: string | null = folderId
  if (path.startsWith('/')) {
    current = null
    segments.shift()
  }
  const last = segments.pop()
  if (!last) return null
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (current === null) return null // 已經在最上層
      current = index.byId.get(current)?.parent_id ?? null
      continue
    }
    const folder = index.children.get(current)?.get(key(segment))
    if (!folder || folder.type !== 'folder') return null
    current = folder.id
  }
  const target = index.children.get(current)?.get(key(last))
  return target?.type === 'image' ? target : null
}

/** 從最上層到 folderId 的資料夾 id（不含最上層的 null）；找不到上層或出現循環時就停 */
function chain(index: PathIndex, folderId: string | null): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (let id = folderId; id && !seen.has(id); id = index.byId.get(id)?.parent_id ?? null) {
    seen.add(id)
    ids.unshift(id)
  }
  return ids
}

/** 從 fromFolderId 資料夾（筆記所在的位置）到 target 的相對路徑，例如「架構圖.webp」「../共用/架構圖.webp」 */
export function relativeImagePath(index: PathIndex, fromFolderId: string | null, target: Node): string {
  const from = chain(index, fromFolderId)
  const to = chain(index, target.parent_id)
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common++
  const up = Array.from({ length: from.length - common }, () => '..')
  const down = to.slice(common).map((id) => index.byId.get(id)?.name ?? '')
  return [...up, ...down, target.name].join('/')
}

/**
 * 放進 Markdown 連結 ![](…) 的位址：有空白或括號時用 <…> 包起來（CommonMark 的寫法），
 * 不然 markdown-it 會把它當成連結的結尾。< > 本身換成 %3C %3E
 */
export function markdownLinkTarget(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : path
}
