// 全文搜尋（spec 第 3 節介面改版第 6 步）：在這台裝置的資料裡找筆記的名稱與內容，離線也能用。
// 這裡只有純函式，不讀 IndexedDB、不碰畫面，方便測試；資料由畫面用 repo.listAll() 取得後傳進來。
//
// - 不分大小寫，照字面找：輸入的 . * ( 等符號就是那個字，不是規則運算式。
// - 圖片的 id（img:<uuid>）不算內容，不然搜「img」或一段十六進位數字，每張圖都會符合。
//   圖片用說明文字找：![說明](img:…) 的「說明」是一般的內容。

import { strings } from '../strings.ts'
import { compareNames, folderPath, type TreeNode } from './nodes.ts'

/** 一段文字；match 為 true 的是符合搜尋的部分（畫面上標示出來） */
export interface TextPart {
  text: string
  match: boolean
}

/** 內容裡符合的一行 */
export interface LineHit {
  /** 第幾行（從 1 起算） */
  line: number
  /** 這一行第一個符合處在整篇內容裡的位置與長度（打開筆記時選取它） */
  offset: number
  length: number
  /** 要顯示的部分（縮排拿掉，很長的行只取符合處附近，截掉的地方接 strings.search.ellipsis），切成符合與不符合的片段 */
  parts: TextPart[]
}

export interface SearchResult {
  note: TreeNode
  /** 所在的資料夾路徑，例如「/課程/第一週/」 */
  path: string
  /** 上層資料夾的 id，從最上層開始（打開時要展開這些資料夾） */
  ancestors: string[]
  /** 名稱切成的片段；名稱沒有符合時為 null */
  name: TextPart[] | null
  /** 內容裡符合的行，最多 MAX_LINES_PER_NOTE 行 */
  lines: LineHit[]
  /** 內容裡符合的處數（包含沒有列出的行） */
  count: number
  /** 沒有列出的行裡還有幾處 */
  hidden: number
}

export interface SearchOutcome {
  /** 最多 MAX_RESULTS 篇 */
  results: SearchResult[]
  /** 符合的筆記總數（包含沒有列出的） */
  noteCount: number
  /** 名稱與內容符合的總處數 */
  matchCount: number
}

/** 最多列出幾篇筆記、每篇最多列出幾行：資料很多時畫面不會卡 */
export const MAX_RESULTS = 100
export const MAX_LINES_PER_NOTE = 5
/** 很長的行只顯示符合處附近：符合處前面最多留幾個字、整段最多幾個字 */
const CONTEXT_BEFORE = 24
const MAX_SNIPPET = 140

const IMAGE_ID = /img:[0-9a-f-]{36}/gi

type Range = [start: number, end: number]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAll(pattern: RegExp, text: string): Range[] {
  const ranges: Range[] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

/** 把 text 依 ranges（相對於 text 開頭，可以超出範圍）切成符合與不符合的片段 */
function toParts(text: string, ranges: Range[]): TextPart[] {
  const parts: TextPart[] = []
  let pos = 0
  for (const [rangeStart, rangeEnd] of ranges) {
    const start = Math.max(rangeStart, pos)
    const end = Math.min(rangeEnd, text.length)
    if (start >= end) continue
    if (start > pos) parts.push({ text: text.slice(pos, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    pos = end
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), match: false })
  return parts
}

/** 一行要顯示的部分：拿掉縮排；太長時從第一個符合處前面一點開始，最多 MAX_SNIPPET 個字 */
function snippet(lineText: string, ranges: Range[]): TextPart[] {
  const first = ranges[0][0]
  const indent = lineText.length - lineText.trimStart().length
  let start = Math.min(indent, first)
  let end = lineText.length
  let clippedStart = false
  if (end - start > MAX_SNIPPET) {
    const from = Math.max(start, first - CONTEXT_BEFORE)
    clippedStart = from > start
    start = from
    end = start + MAX_SNIPPET
  }
  const parts = toParts(
    lineText.slice(start, end),
    ranges.map(([s, e]): Range => [s - start, e - start]),
  )
  if (clippedStart) parts.unshift({ text: strings.search.ellipsis, match: false })
  if (end < lineText.length) parts.push({ text: strings.search.ellipsis, match: false })
  return parts
}

/** 內容裡的符合處依行分組，列出前 MAX_LINES_PER_NOTE 行 */
function lineHits(content: string, ranges: Range[]): { lines: LineHit[]; hidden: number } {
  const lines: LineHit[] = []
  let hidden = 0
  let lineNumber = 1
  let counted = 0 // content 在這個位置之前的換行都已經算進 lineNumber
  let i = 0
  while (i < ranges.length) {
    const start = ranges[i][0]
    const lineStart = content.lastIndexOf('\n', start - 1) + 1
    const newline = content.indexOf('\n', start)
    const lineEnd = newline === -1 ? content.length : newline
    for (let p = content.indexOf('\n', counted); p !== -1 && p < lineStart; p = content.indexOf('\n', p + 1)) lineNumber++
    counted = lineStart
    // 同一行的符合處
    const inLine: Range[] = []
    while (i < ranges.length && ranges[i][0] < lineEnd) inLine.push(ranges[i++])
    if (lines.length < MAX_LINES_PER_NOTE) {
      const lineText = content.slice(lineStart, lineEnd).replace(/\r$/, '')
      lines.push({
        line: lineNumber,
        offset: inLine[0][0],
        length: inLine[0][1] - inLine[0][0],
        parts: snippet(
          lineText,
          inLine.map(([s, e]): Range => [s - lineStart, e - lineStart]),
        ),
      })
    } else {
      hidden += inLine.length
    }
  }
  return { lines, hidden }
}

/** 資料夾路徑裡有幾層資料夾（最上層的「/」是 0） */
export function folderDepth(path: string): number {
  return path === '/' ? 0 : path.split('/').length - 2
}

/**
 * 縮短資料夾路徑：從最上層開始，前 count 層只留第一個字（例如 /o.../t.../final/）。
 * 最深的資料夾最後才縮，因為它最能說明筆記在哪裡；兩個字以內的名稱不縮（縮了不會比較短）
 */
export function abbreviatePath(path: string, count: number): string {
  if (path === '/' || count <= 0) return path
  const folders = path.slice(1, -1).split('/')
  const short = folders.map((name, index) => {
    const chars = [...name]
    return index < count && chars.length > 2 ? chars[0] + strings.search.ellipsis : name
  })
  return `/${short.join('/')}/`
}

/** 上層資料夾的 id，從最上層開始；找不到或出現循環就停 */
function ancestorsOf(note: TreeNode, byId: Map<string, TreeNode>): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (let id = note.parent_id; id && !seen.has(id) && byId.has(id); id = byId.get(id)!.parent_id) {
    seen.add(id)
    ids.unshift(id)
  }
  return ids
}

/**
 * 在 nodes（這台裝置上所有的資料夾與筆記）裡找名稱或內容含有 query 的筆記。
 * 名稱符合的排前面，其餘依資料夾路徑與名稱排序（跟資料夾樹的順序一樣）
 */
export function searchNotes(nodes: TreeNode[], query: string): SearchOutcome {
  const text = query.trim().normalize('NFC')
  if (!text) return { results: [], noteCount: 0, matchCount: 0 }
  const pattern = new RegExp(escapeRegExp(text), 'giu')
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const found: { note: TreeNode; path: string; nameRanges: Range[]; ranges: Range[] }[] = []
  let matchCount = 0
  for (const note of nodes) {
    if (note.type !== 'note') continue
    const nameRanges = findAll(pattern, note.name)
    // 圖片 id 換成同樣長度的空字元：位置不變，但不會被找到
    const masked = (note.content ?? '').replace(IMAGE_ID, (id) => '\u0000'.repeat(id.length))
    const ranges = findAll(pattern, masked)
    if (nameRanges.length === 0 && ranges.length === 0) continue
    matchCount += nameRanges.length + ranges.length
    found.push({ note, path: folderPath(note.parent_id, (id) => byId.get(id)), nameRanges, ranges })
  }

  found.sort(
    (a, b) =>
      Number(b.nameRanges.length > 0) - Number(a.nameRanges.length > 0) ||
      compareNames(a.path, b.path) ||
      compareNames(a.note.name, b.note.name),
  )

  const results = found.slice(0, MAX_RESULTS).map(({ note, path, nameRanges, ranges }): SearchResult => {
    const { lines, hidden } = lineHits(note.content ?? '', ranges)
    return {
      note,
      path,
      ancestors: ancestorsOf(note, byId),
      name: nameRanges.length > 0 ? toParts(note.name, nameRanges) : null,
      lines,
      count: ranges.length,
      hidden,
    }
  })
  return { results, noteCount: found.length, matchCount }
}
