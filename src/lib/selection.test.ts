import { describe, expect, it } from 'vitest'
import { rangeBetween, topLevelOnly, visibleOrder } from './selection.ts'

// 課程/（展開）
//   第一週/（收合）
//     筆記 A
//   筆記 B
// 首頁
const items = [
  { id: 'course', type: 'folder', parent_id: null },
  { id: 'week', type: 'folder', parent_id: 'course' },
  { id: 'a', type: 'note', parent_id: 'week' },
  { id: 'b', type: 'note', parent_id: 'course' },
  { id: 'home', type: 'note', parent_id: null },
]
const childrenOf = (parentId: string | null) => items.filter((item) => item.parent_id === parentId)
const parentOf = (id: string) => items.find((item) => item.id === id)?.parent_id

describe('visibleOrder', () => {
  it('依畫面的順序列出看得到的項目，收合的資料夾裡面不列', () => {
    expect(visibleOrder(childrenOf, new Set(['course']))).toEqual(['course', 'week', 'b', 'home'])
    expect(visibleOrder(childrenOf, new Set(['course', 'week']))).toEqual(['course', 'week', 'a', 'b', 'home'])
    expect(visibleOrder(childrenOf, new Set())).toEqual(['course', 'home'])
  })

  it('還沒載入的資料夾當成空的；資料暫時有循環時不會無限展開', () => {
    expect(visibleOrder(() => undefined, new Set())).toEqual([])
    const loop = [
      { id: 'x', type: 'folder', parent_id: null },
      { id: 'y', type: 'folder', parent_id: 'x' },
    ]
    const loopChildren = (parentId: string | null) =>
      parentId === null ? [loop[0]] : parentId === 'x' ? [loop[1]] : parentId === 'y' ? [loop[0]] : []
    expect(visibleOrder(loopChildren, new Set(['x', 'y']))).toEqual(['x', 'y'])
  })
})

describe('rangeBetween', () => {
  const order = ['course', 'week', 'a', 'b', 'home']

  it('包含兩端，往上往下都可以', () => {
    expect(rangeBetween(order, 'week', 'b')).toEqual(['week', 'a', 'b'])
    expect(rangeBetween(order, 'home', 'a')).toEqual(['a', 'b', 'home'])
    expect(rangeBetween(order, 'a', 'a')).toEqual(['a'])
  })

  it('沒有起點、或起點已經看不到時只選點的那一個', () => {
    expect(rangeBetween(order, null, 'b')).toEqual(['b'])
    expect(rangeBetween(order, 'gone', 'b')).toEqual(['b'])
  })
})

describe('topLevelOnly', () => {
  it('資料夾和它裡面的項目都選了時，只留資料夾（不管隔幾層）', () => {
    const picked = items.filter((item) => ['course', 'a', 'home'].includes(item.id))
    expect(topLevelOnly(picked, parentOf).map((item) => item.id)).toEqual(['course', 'home'])
  })

  it('沒有上下層關係時全部保留', () => {
    const picked = items.filter((item) => ['a', 'b', 'home'].includes(item.id))
    expect(topLevelOnly(picked, parentOf).map((item) => item.id)).toEqual(['a', 'b', 'home'])
  })
})
