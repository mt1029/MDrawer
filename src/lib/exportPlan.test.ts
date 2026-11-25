// @vitest-environment jsdom
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildZip, planExport, toSafeFileName } from './exportPlan.ts'
import type { TreeNode } from './nodes.ts'

const IMG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const IMG_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const MISSING = 'cccccccc-0000-4000-8000-000000000003'

let seq = 0
function node(partial: Partial<TreeNode> & Pick<TreeNode, 'type' | 'name'>): TreeNode {
  seq++
  return {
    id: partial.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    parent_id: null,
    content: partial.type === 'note' ? '' : null,
    version: 1,
    created_at: '2026-11-25T00:00:00Z',
    updated_at: '2026-11-25T08:30:00Z',
    ...partial,
  }
}

const ext = (id: string) => (id === IMG_B ? 'jpg' : 'webp')

describe('toSafeFileName：各作業系統都能用的檔名', () => {
  it.each([
    ['一般名稱', '一般名稱'],
    ['a:b', 'a_b'],
    ['問號?星號*', '問號_星號_'],
    ['<尖括號>|"', '_尖括號___'],
    ['結尾有點.', '結尾有點'],
    ['結尾有空白 ', '結尾有空白'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['LPT1', '_LPT1'],
    ['console', 'console'],
    ['...', '_'],
  ])('%s → %s', (input, output) => {
    expect(toSafeFileName(input)).toBe(output)
  })
})

describe('planExport：資料夾結構與相對路徑', () => {
  const a = node({ type: 'folder', name: '課程' })
  const b = node({ type: 'folder', name: '第一週', parent_id: a.id })
  const deep = node({ type: 'note', name: '筆記', parent_id: b.id, content: `![](img:${IMG_A})\n![說明](img:${IMG_B})` })
  const readme = node({ type: 'note', name: 'README.md', parent_id: a.id })
  const root = node({ type: 'note', name: '首頁', content: `![](img:${IMG_A})` })
  const empty = node({ type: 'folder', name: '空資料夾' })
  const plan = planExport([deep, root, readme, b, a, empty], ext)

  it('保留資料夾結構，空資料夾也保留', () => {
    expect(plan.folders.map((f) => f.path).sort()).toEqual(['空資料夾', '課程', '課程/第一週'].sort())
    expect(plan.notes.map((n) => n.path).sort()).toEqual(['首頁.md', '課程/第一週/筆記.md', '課程/README.md'].sort())
  })

  it('圖片改成從筆記所在位置出發的相對路徑，副檔名依格式', () => {
    const deepNote = plan.notes.find((n) => n.path === '課程/第一週/筆記.md')
    expect(deepNote?.content).toBe(`![](../../images/${IMG_A}.webp)\n![說明](../../images/${IMG_B}.jpg)`)
    expect(plan.notes.find((n) => n.path === '首頁.md')?.content).toBe(`![](images/${IMG_A}.webp)`)
  })

  it('檔案時間是最後修改時間', () => {
    expect(plan.notes.every((n) => n.date.toISOString() === '2026-11-25T08:30:00.000Z')).toBe(true)
  })
})

describe('planExport：避免撞名', () => {
  it('最上層的「images」資料夾讓給圖片，使用者的改名為 images (2)', () => {
    const plan = planExport([node({ type: 'folder', name: 'images' })], ext)
    expect(plan.folders[0].path).toBe('images (2)')
  })

  it('淨化後同名（不分大小寫）時加上編號', () => {
    const plan = planExport([node({ type: 'note', name: 'A?' }), node({ type: 'note', name: 'a_' })], ext)
    const paths = plan.notes.map((n) => n.path)
    // 兩個都存在，而且其中一個加上了編號（誰先拿到原名取決於排序）
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(2)
    expect(paths.filter((p) => p.endsWith(' (2).md'))).toHaveLength(1)
  })

  it('資料夾「X.md」與筆記「X」不會互相覆蓋', () => {
    const plan = planExport([node({ type: 'folder', name: 'X.md' }), node({ type: 'note', name: 'X' })], ext)
    expect(plan.folders[0].path).toBe('X.md')
    expect(plan.notes[0].path).toBe('X (2).md')
  })
})

describe('planExport：異常資料也不會漏掉', () => {
  it('上層資料夾不存在時放到最上層', () => {
    const orphan = node({ type: 'note', name: '孤兒', parent_id: '99999999-0000-4000-8000-000000000000' })
    expect(planExport([orphan], ext).notes[0].path).toBe('孤兒.md')
  })

  it('兩個資料夾互為上層（循環）時仍會匯出，且不會無限迴圈', () => {
    const x = node({ type: 'folder', name: 'X' })
    const y = node({ type: 'folder', name: 'Y', parent_id: x.id })
    x.parent_id = y.id
    const note = node({ type: 'note', name: '裡面', parent_id: y.id })
    const plan = planExport([x, y, note], ext)
    expect(plan.folders.map((f) => f.path)).toEqual(['X', 'X/Y'])
    expect(plan.notes.map((n) => n.path)).toEqual(['X/Y/裡面.md'])
  })
})

/** 把筆記裡的相對路徑換算成 ZIP 裡的完整路徑 */
function resolve(notePath: string, link: string): string {
  const parts = notePath.split('/').slice(0, -1)
  for (const segment of link.split('/')) {
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

describe('buildZip：解壓後圖片連結都找得到檔案（spec 驗收條件）', () => {
  it('每篇筆記裡的圖片連結都指向 ZIP 裡存在的圖片', async () => {
    const a = node({ type: 'folder', name: '課程' })
    const b = node({ type: 'folder', name: '第一週', parent_id: a.id })
    const notes = [
      node({ type: 'note', name: '根目錄', content: `![](img:${IMG_A})` }),
      node({ type: 'note', name: '第一層', parent_id: a.id, content: `![](img:${IMG_B})` }),
      node({ type: 'note', name: '第二層', parent_id: b.id, content: `文字\n\n![](img:${IMG_A}) 與 ![](img:${IMG_B})` }),
    ]
    const images = new Map([
      [IMG_A, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' })],
      [IMG_B, new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' })],
    ])
    const plan = planExport([a, b, ...notes], (id) => (images.get(id)?.type === 'image/jpeg' ? 'jpg' : 'webp'))
    const zip = await JSZip.loadAsync(await buildZip(plan, images))

    expect(zip.file(`images/${IMG_A}.webp`)).not.toBeNull()
    expect(zip.file(`images/${IMG_B}.jpg`)).not.toBeNull()

    let checked = 0
    for (const note of plan.notes) {
      const text = await zip.file(note.path)!.async('string')
      expect(text).toBe(note.content)
      for (const [, link] of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        expect(zip.file(resolve(note.path, link)), `${note.path} → ${link}`).not.toBeNull()
        checked++
      }
    }
    expect(checked).toBe(4)
  })

  it('下載失敗的圖片仍改成相對路徑（之後補上檔案就能顯示），其他內容照常匯出', async () => {
    const plan = planExport([node({ type: 'note', name: '缺圖', content: `![](img:${MISSING})` })], () => 'webp')
    const zip = await JSZip.loadAsync(await buildZip(plan, new Map()))
    expect(await zip.file('缺圖.md')!.async('string')).toBe(`![](images/${MISSING}.webp)`)
  })
})
