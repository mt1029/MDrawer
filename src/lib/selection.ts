// 檔案總管的多選（⌘／Ctrl 點選加入或取消、Shift 點選選一段範圍）。純函式，方便測試。

interface Item {
  id: string
  type: string
  parent_id: string | null
}

/**
 * 畫面上看得到的項目依顯示的順序排好（從上到下）：展開的資料夾才會列出裡面的項目。
 * childrenOf(null) 是最上層；還沒載入的資料夾回傳 undefined
 */
export function visibleOrder<T extends Item>(
  childrenOf: (parentId: string | null) => T[] | undefined,
  expanded: ReadonlySet<string>,
): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const walk = (parentId: string | null) => {
    for (const node of childrenOf(parentId) ?? []) {
      if (seen.has(node.id)) continue // 資料暫時有循環時不要無限展開
      seen.add(node.id)
      order.push(node.id)
      if (node.type === 'folder' && expanded.has(node.id)) walk(node.id)
    }
  }
  walk(null)
  return order
}

/** Shift 點選：從 anchor 到 target 之間（含兩端，依畫面順序）的項目；任一個不在畫面上時只選 target */
export function rangeBetween(order: string[], anchor: string | null, target: string): string[] {
  const from = anchor ? order.indexOf(anchor) : -1
  const to = order.indexOf(target)
  if (from === -1 || to === -1) return [target]
  return order.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/**
 * 只留最上層的項目：資料夾和它裡面的項目都選了時，只處理資料夾（裡面的會跟著移動、複製、刪除），
 * 不然會重複處理，或把裡面的項目搬出來。parentOf 用 id 找上層資料夾的 id
 */
export function topLevelOnly<T extends { id: string }>(items: T[], parentOf: (id: string) => string | null | undefined): T[] {
  const ids = new Set(items.map((item) => item.id))
  return items.filter((item) => {
    const seen = new Set<string>()
    for (let parent = parentOf(item.id); parent && !seen.has(parent); parent = parentOf(parent)) {
      if (ids.has(parent)) return false
      seen.add(parent)
    }
    return true
  })
}
