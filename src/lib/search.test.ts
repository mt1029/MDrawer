import { describe, expect, it } from 'vitest'
import type { TreeNode } from './nodes.ts'
import { strings } from '../strings.ts'
import { MAX_LINES_PER_NOTE, MAX_RESULTS, abbreviatePath, folderDepth, searchNotes, type TextPart } from './search.ts'

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

/** 片段接回一行文字，符合的部分用 [] 標出來，方便比對 */
const show = (parts: TextPart[] | null) => parts?.map((p) => (p.match ? `[${p.text}]` : p.text)).join('') ?? null


describe('searchNotes', () => {
  it('沒有輸入（或只有空白）時沒有結果', () => {
    const notes = [node({ type: 'note', name: '筆記', content: '內容' })]
    expect(searchNotes(notes, '').results).toEqual([])
    expect(searchNotes(notes, '   ').results).toEqual([])
  })

  it('找名稱與內容，不分大小寫，只找筆記不找資料夾', () => {
    const folder = node({ type: 'folder', name: 'React 資料夾' })
    const byName = node({ type: 'note', name: 'React 筆記', content: '' })
    const byContent = node({ type: 'note', name: '其他', content: '學習 react hooks' })
    const none = node({ type: 'note', name: '無關', content: '沒有' })
    const { results, noteCount, matchCount } = searchNotes([folder, byName, byContent, none], 'REACT')
    expect(results.map((r) => r.note.id)).toEqual([byName.id, byContent.id]) // 名稱符合的排前面
    expect(show(results[0].name)).toBe('[React] 筆記')
    expect(results[1].name).toBeNull()
    expect(show(results[1].lines[0].parts)).toBe('學習 [react] hooks')
    expect(noteCount).toBe(2)
    expect(matchCount).toBe(2)
  })

  it('照字面找：. ( * 等符號不是規則運算式', () => {
    const notes = [node({ type: 'note', name: 'a', content: 'axb\na.b\nf(x)*2' })]
    expect(searchNotes(notes, 'a.b').results[0].lines.map((l) => l.line)).toEqual([2])
    expect(show(searchNotes(notes, '(x)*').results[0].lines[0].parts)).toBe('f[(x)*]2')
  })

  it('圖片的連結裡的說明與檔名也找得到', () => {
    const note = node({ type: 'note', name: '圖', content: '![系統架構](架構圖.webp)\n其他文字' })
    expect(show(searchNotes([note], '架構').results[0].lines[0].parts)).toBe('![系統[架構]]([架構]圖.webp)')
    expect(searchNotes([note], '.webp').results[0].lines.map((l) => l.line)).toEqual([1])
  })

  it('行號與位置對得上內容，同一行的多個符合處合成一行', () => {
    const content = '第一行\n  縮排的 todo 與 TODO\n\n最後 todo'
    const note = node({ type: 'note', name: 'n', content })
    const [result] = searchNotes([note], 'todo').results
    expect(result.count).toBe(3)
    expect(result.lines.map((l) => l.line)).toEqual([2, 4])
    const [first, second] = result.lines
    expect(content.slice(first.offset, first.offset + first.length)).toBe('todo')
    expect(content.slice(second.offset, second.offset + second.length)).toBe('todo')
    expect(show(first.parts)).toBe('縮排的 [todo] 與 [TODO]') // 縮排拿掉
  })

  it(`每篇最多列出 ${MAX_LINES_PER_NOTE} 行，其餘算在 hidden`, () => {
    const content = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行 x x`).join('\n')
    const [result] = searchNotes([node({ type: 'note', name: 'n', content })], 'x').results
    expect(result.count).toBe(16)
    expect(result.lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5])
    expect(result.hidden).toBe(6)
  })

  it('很長的行只顯示符合處附近，截掉的地方接 strings 的省略符號', () => {
    const content = `${'前'.repeat(200)}關鍵字${'後'.repeat(200)}`
    const [result] = searchNotes([node({ type: 'note', name: 'n', content })], '關鍵字').results
    const text = show(result.lines[0].parts)!
    expect(text.startsWith(strings.search.ellipsis)).toBe(true)
    expect(text.endsWith(strings.search.ellipsis)).toBe(true)
    expect(text).toContain('[關鍵字]')
    expect(text.length).toBeLessThan(160)
  })

  it('路徑、上層資料夾與排序（名稱符合的優先，再依路徑與名稱）', () => {
    const course = node({ type: 'folder', name: '課程' })
    const week = node({ type: 'folder', name: '第一週', parent_id: course.id })
    const deep = node({ type: 'note', name: '筆記 10', parent_id: week.id, content: '關鍵' })
    const deep2 = node({ type: 'note', name: '筆記 2', parent_id: week.id, content: '關鍵' })
    const root = node({ type: 'note', name: '首頁', content: '關鍵' })
    const named = node({ type: 'note', name: '關鍵字整理', parent_id: week.id, content: '' })
    const { results } = searchNotes([course, week, deep, deep2, root, named], '關鍵')
    expect(results.map((r) => r.note.name)).toEqual(['關鍵字整理', '首頁', '筆記 2', '筆記 10'])
    expect(results[2].path).toBe('/課程/第一週/')
    expect(results[2].ancestors).toEqual([course.id, week.id])
    expect(results[1].path).toBe('/')
    expect(results[1].ancestors).toEqual([])
  })

  it(`最多列出 ${MAX_RESULTS} 篇，總數照算`, () => {
    const notes = Array.from({ length: MAX_RESULTS + 20 }, (_, i) => node({ type: 'note', name: `n${i}`, content: 'hit' }))
    const outcome = searchNotes(notes, 'hit')
    expect(outcome.results).toHaveLength(MAX_RESULTS)
    expect(outcome.noteCount).toBe(MAX_RESULTS + 20)
  })
})

describe('abbreviatePath', () => {
  const e = strings.search.ellipsis

  it('資料夾層數', () => {
    expect(folderDepth('/')).toBe(0)
    expect(folderDepth('/課程/')).toBe(1)
    expect(folderDepth('/one/two/three/final/')).toBe(4)
  })

  it('從最上層開始縮，每層只留第一個字，最深的最後縮', () => {
    const path = '/one/two/three/final/'
    expect(abbreviatePath(path, 0)).toBe(path)
    expect(abbreviatePath(path, 1)).toBe(`/o${e}/two/three/final/`)
    expect(abbreviatePath(path, 3)).toBe(`/o${e}/t${e}/t${e}/final/`)
    expect(abbreviatePath(path, 4)).toBe(`/o${e}/t${e}/t${e}/f${e}/`)
    expect(abbreviatePath(path, 99)).toBe(`/o${e}/t${e}/t${e}/f${e}/`)
  })

  it('中文名稱一樣只留第一個字；兩個字以內不縮；最上層不變', () => {
    expect(abbreviatePath('/課程/資料結構/', 2)).toBe(`/課程/資${e}/`)
    expect(abbreviatePath('/ab/x/', 2)).toBe('/ab/x/')
    expect(abbreviatePath('/', 3)).toBe('/')
  })
})
