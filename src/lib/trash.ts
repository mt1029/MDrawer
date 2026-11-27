// 垃圾桶（加分層，spec 第 3 節）：刪除的項目在雲端只標記 deleted_at，垃圾桶列出這些列，可以還原或永久刪除。
// 只在連線時使用（資料在雲端），由 mirror.ts 提供給 UI。
//
// 同一次刪除（資料夾連同裡面的項目）的 deleted_at 一樣（repo.local.ts 的 deleteNode），合成一筆；
// 資料夾刪除之前就先刪掉的項目是另外一筆，還原資料夾時不會跟著回來。

import type { Cloud, RowChanges, TrashRow } from './cloud.ts'
import { RepoError, compareNames, folderPath, numberedName, type NodeMeta } from './nodes.ts'
import { strings } from '../strings.ts'

type LiveNode = Pick<NodeMeta, 'id' | 'name' | 'parent_id'>

export interface TrashEntry {
  /** 這次刪除最上層的項目（資料夾、筆記或圖片） */
  node: TrashRow
  /** 一起刪除的所有列：第一個是 node，上層在前 */
  rows: TrashRow[]
  /** 原本所在的資料夾路徑，例如「/課程/第一週/」；那個資料夾也刪除了時，照它刪除前的名稱 */
  path: string
  /** 列出時，原本所在的資料夾還在（或原本就在最上層）。還原時會用當時的資料重新判斷 */
  parentAlive: boolean
}

/**
 * 把垃圾桶的列整理成一筆一筆（同一次刪除的合成一筆），新刪除的在前。
 * live 是還沒刪除的項目（這台裝置的資料），用來判斷原本的資料夾還在不在、顯示路徑
 */
export function groupTrash(trash: TrashRow[], live: LiveNode[]): TrashEntry[] {
  const trashById = new Map(trash.map((row) => [row.id, row]))
  const liveById = new Map(live.map((node) => [node.id, node]))
  const childrenOf = new Map<string, TrashRow[]>()
  for (const row of trash) {
    if (!row.parent_id) continue
    const list = childrenOf.get(row.parent_id) ?? []
    list.push(row)
    childrenOf.set(row.parent_id, list)
  }

  /** 上層資料夾也在垃圾桶裡、而且是同一次刪除的 */
  const sameDeletionAsParent = (row: TrashRow) => {
    const parent = row.parent_id ? trashById.get(row.parent_id) : undefined
    return parent !== undefined && parent.deleted_at === row.deleted_at
  }
  /** 往上都是同一次刪除、最後繞回自己（資料暫時有循環）：當成最上層，免得整組不見 */
  const inCycle = (row: TrashRow) => {
    const seen = new Set<string>()
    for (let current = row; sameDeletionAsParent(current); current = trashById.get(current.parent_id!)!) {
      if (seen.has(current.id)) return true
      seen.add(current.id)
    }
    return false
  }

  const claimed = new Set<string>()
  const entries: TrashEntry[] = []
  for (const row of trash) {
    if (claimed.has(row.id) || (sameDeletionAsParent(row) && !inCycle(row))) continue
    // 同一次刪除的子孫（上層在前）
    const rows = [row]
    claimed.add(row.id)
    for (let i = 0; i < rows.length; i++) {
      for (const child of childrenOf.get(rows[i].id) ?? []) {
        if (child.deleted_at !== row.deleted_at || claimed.has(child.id)) continue
        claimed.add(child.id)
        rows.push(child)
      }
    }
    entries.push({
      node: row,
      rows,
      path: folderPath(row.parent_id, (id) => liveById.get(id) ?? trashById.get(id)),
      parentAlive: row.parent_id === null || liveById.has(row.parent_id),
    })
  }
  return entries.sort(
    (a, b) => Date.parse(b.node.deleted_at ?? '') - Date.parse(a.node.deleted_at ?? '') || compareNames(a.node.name, b.node.name),
  )
}

export interface RestoreResult {
  /** 還原後的名稱（撞名時加了編號） */
  name: string
  /** 放到哪個資料夾（null 為最上層） */
  parentId: string | null
  /** 原本的資料夾已經不在，放到最上層 */
  movedToRoot: boolean
}

// 撞名時最多試幾個編號
const MAX_RENAME = 20

/**
 * 還原一筆：一起刪除的項目全部回來（上層先）。放回原本的資料夾，已經不在時放到最上層；
 * 撞名時加「 (2)」。live 是還沒刪除的項目（這台裝置目前的資料），用來判斷原本的資料夾在不在
 * （一次還原好幾筆時，先還原的資料夾也算）、先選好不撞名的名稱
 */
export async function restoreEntry(
  cloud: Pick<Cloud, 'updateIfVersion'>,
  entry: TrashEntry,
  live: LiveNode[],
): Promise<RestoreResult> {
  const original = entry.node.parent_id
  const parentAlive = original === null || live.some((node) => node.id === original)
  const parentId = parentAlive ? original : null
  const taken = new Set(live.filter((node) => node.parent_id === parentId).map((node) => node.name.toLowerCase()))
  let topNumber = 1
  while (taken.has((topNumber === 1 ? entry.node.name : numberedName(entry.node.name, topNumber)).toLowerCase())) topNumber++

  let restoredName = entry.node.name
  for (const [index, row] of entry.rows.entries()) {
    const isTop = index === 0
    // 雲端已經有同名的項目（這台裝置還沒同步到）時加編號再試
    for (let number = isTop ? topNumber : 1; ; number++) {
      const name = number === 1 ? row.name : numberedName(row.name, number)
      const changes: RowChanges = { deleted_at: null }
      if (isTop && parentId !== row.parent_id) changes.parent_id = parentId
      if (name !== row.name) changes.name = name
      try {
        // 版本不同：列出垃圾桶之後，這一列被別台裝置還原、永久刪除或改過
        if (!(await cloud.updateIfVersion(row.id, changes, row.version))) {
          throw new RepoError('unknown', strings.trash.changed)
        }
        if (isTop) restoredName = name
        break
      } catch (err) {
        if (!(err instanceof RepoError && err.kind === 'duplicate_name') || number >= MAX_RENAME) throw err
      }
    }
  }
  return { name: restoredName, parentId, movedToRoot: !parentAlive }
}

/**
 * 永久刪除（清空垃圾桶時傳入全部）。圖片的檔案沒有其他項目用到時，從 Storage 刪掉；
 * 刪檔案失敗（例如斷線）不影響結果，只是留下用不到的檔案。回傳處理了幾列
 */
export async function purgeEntries(cloud: Pick<Cloud, 'purge' | 'removeImageIfUnused'>, entries: TrashEntry[]): Promise<number> {
  const purged = await cloud.purge(entries.flatMap((entry) => entry.rows.map((row) => row.id)))
  const files = new Set(purged.flatMap((row) => (row.type === 'image' && row.content ? [row.content] : [])))
  for (const fileId of files) await cloud.removeImageIfUnused(fileId).catch(() => false)
  return purged.length
}
