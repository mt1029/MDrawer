// 匯入的「規劃」部分：哪些檔案要匯入、放在哪個資料夾、叫什麼名字，以及筆記裡圖片連結的改寫。
// 不讀寫資料，方便單元測試；讀檔案與建立項目在 import.ts。
//
// 匯入的東西保持原本的資料夾結構：.md、.markdown 變成筆記（名稱去掉副檔名），圖片壓縮後變成圖片項目，
// 其他檔案略過。圖片壓縮後副檔名會變（a.png → a.webp），撞名時也會加編號（a (2).webp），
// 所以筆記裡指到匯入圖片的連結要跟著改，匯入後圖片才顯示得出來。

import {
  createPathIndex,
  decodeImagePath,
  isLocalImagePath,
  markdownLinkTarget,
  relativeImagePath,
  resolveImagePath,
  type PathIndex,
} from './imagePaths.ts'
import { MAX_NAME_LENGTH, normalizeName, type NodeType } from './nodes.ts'
import { strings } from '../strings.ts'

/** 要匯入的一個檔案。path 是相對於匯入位置的路徑，以 / 分隔，例如「課程/第一週/筆記.md」 */
export interface ImportFile {
  path: string
  file: Blob
}

/** 圖片的副檔名 → 檔案類型（ZIP 裡的檔案沒有類型，壓縮前要補上）。SVG 無法轉成點陣圖，不算圖片 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
}

const NOTE_EXTENSION = /\.(md|markdown)$/i
/** 作業系統自己產生的檔案：直接忽略，不算「略過的檔案」 */
const SYSTEM_FILES = /^(thumbs\.db|desktop\.ini)$/i

/** 圖片的檔案類型（依副檔名）；不是支援的圖片時回傳 undefined */
export function imageTypeOf(name: string): string | undefined {
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase()
  return extension ? IMAGE_TYPES[extension] : undefined
}

export type ImportKind = 'note' | 'image' | 'other'

export function importKind(name: string): ImportKind {
  if (NOTE_EXTENSION.test(name)) return 'note'
  if (imageTypeOf(name)) return 'image'
  return 'other'
}

/** 隱藏檔（. 開頭，例如 .DS_Store、.git）、macOS 壓縮時加的 __MACOSX、系統檔：整個忽略 */
function isIgnoredSegment(segment: string): boolean {
  return segment.startsWith('.') || segment === '__MACOSX' || SYSTEM_FILES.test(segment)
}

/**
 * 路徑拆成每一層的名稱（統一 Unicode 組合方式，去掉空的與「.」）。
 * 有「..」（不應該出現，可能是惡意的 ZIP）或要忽略的檔案、資料夾時回傳 null
 */
export function splitImportPath(path: string): string[] | null {
  const segments = path
    .split(/[/\\]/)
    .map((segment) => segment.normalize('NFC'))
    .filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..' || isIgnoredSegment(segment))) return null
  return segments
}

/** 把匯入的檔名、資料夾名稱轉成符合名稱規則的名稱（spec 第 5 節）；換完是空的時叫「未命名」 */
export function toNodeName(raw: string): string {
  const cleaned = normalizeName(raw)
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
  const chars = [...cleaned]
  const name = chars.length <= MAX_NAME_LENGTH ? cleaned : chars.slice(0, MAX_NAME_LENGTH).join('').trimEnd()
  return name || strings.imports.untitled
}

export interface PlannedEntry {
  /** 原本的路徑（拆開再接起來的，當成這個項目的代號） */
  path: string
  /** 所在資料夾的路徑；null 為匯入的位置 */
  parent: string | null
  /**
   * 要建立的名稱：資料夾、筆記已轉成符合規則的名稱（筆記去掉副檔名）；
   * 圖片是原本的檔名，壓縮後才知道副檔名，由 imageFileName 決定
   */
  name: string
}

export interface PlannedFile extends PlannedEntry {
  file: Blob
}

export interface ImportPlan {
  /** 上層的資料夾排在前面 */
  folders: PlannedEntry[]
  notes: PlannedFile[]
  images: PlannedFile[]
  /** 不支援的檔案（路徑），略過 */
  skipped: string[]
}

/**
 * 整理要匯入的東西。folders 是空的資料夾（選資料夾、拖曳、ZIP 裡沒有檔案的資料夾），有檔案的資料夾會自動加上
 */
export function planImport(files: ImportFile[], folders: string[] = []): ImportPlan {
  const plan: ImportPlan = { folders: [], notes: [], images: [], skipped: [] }
  const folderPaths = new Map<string, string[]>()
  const addFolders = (segments: string[]) => {
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join('/')
      if (!folderPaths.has(path)) folderPaths.set(path, segments.slice(0, depth))
    }
  }
  const parentOf = (segments: string[]) => (segments.length > 1 ? segments.slice(0, -1).join('/') : null)

  for (const folder of folders) {
    const segments = splitImportPath(folder)
    if (segments) addFolders(segments)
  }
  for (const { path, file } of files) {
    const segments = splitImportPath(path)
    if (!segments) continue
    const fileName = segments[segments.length - 1]
    const kind = importKind(fileName)
    if (kind === 'other') {
      plan.skipped.push(segments.join('/'))
      continue
    }
    addFolders(segments.slice(0, -1))
    const entry = { path: segments.join('/'), parent: parentOf(segments), file }
    if (kind === 'note') plan.notes.push({ ...entry, name: toNodeName(fileName.replace(NOTE_EXTENSION, '')) })
    else plan.images.push({ ...entry, name: fileName })
  }

  plan.folders = [...folderPaths.values()]
    .sort((a, b) => a.length - b.length)
    .map((segments) => ({
      path: segments.join('/'),
      parent: parentOf(segments),
      name: toNodeName(segments[segments.length - 1]),
    }))
  return plan
}

// ---- 筆記裡圖片連結的改寫 ----

interface LinkNode {
  id: string
  parent_id: string | null
  type: NodeType
  name: string
}

/** 匯入前（原本的檔名）與匯入後（建立的名稱）的資料夾、圖片，以原本的路徑為 id，匯入的位置為最上層 */
export interface LinkSpaces {
  before: PathIndex<LinkNode>
  after: PathIndex<LinkNode>
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** created 是原本的路徑 → 建立的名稱（只有成功建立的資料夾與圖片） */
export function linkSpaces(plan: ImportPlan, created: ReadonlyMap<string, string>): LinkSpaces {
  const before: LinkNode[] = []
  const after: LinkNode[] = []
  const add = (entry: PlannedEntry, type: NodeType) => {
    before.push({ id: entry.path, parent_id: entry.parent, type, name: lastSegment(entry.path) })
    const name = created.get(entry.path)
    if (name !== undefined) after.push({ id: entry.path, parent_id: entry.parent, type, name })
  }
  for (const folder of plan.folders) add(folder, 'folder')
  for (const image of plan.images) add(image, 'image')
  return { before: createPathIndex(before), after: createPathIndex(after) }
}

/** 把文字換成等長的空白（保留換行），讓程式碼裡看起來像連結的字不會被改到，位置也不變 */
const blank = (text: string) => text.replace(/[^\n]/g, ' ')

/** 程式碼區塊（``` 或 ~~~）與行內程式碼（`…`）的內容換成空白 */
function maskCode(source: string): string {
  const lines = source.split('\n')
  let fence: { char: string; length: number } | null = null
  const masked = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null
      return blank(line)
    }
    if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) {
      fence = { char: marker[0], length: marker.length }
      return blank(line)
    }
    return line
  })
  // 行內程式碼：前後一樣多個 `，中間不跨過空白行（段落）
  return masked.join('\n').replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, blank)
}

// ![說明](位址 "標題")：說明裡可以有一層 [ ]；位址是 <…> 或沒有空白的一串（可以有成對的括號）
const IMAGE_LINK =
  /!\[(?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*\]\([ \t]*\n?[ \t]*(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)/g
// [代號]: 位址（參考式連結的定義，![說明][代號] 會用到）
const REFERENCE_DEFINITION = /^ {0,3}\[(?:[^[\]\\]|\\.)+\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|\S+)/gm

/** 一個連結位址要換成什麼；不用換時回傳 null */
function retarget(raw: string, folder: string | null, spaces: LinkSpaces): string | null {
  const bracketed = raw.startsWith('<') && raw.endsWith('>')
  const path = decodeImagePath(bracketed ? raw.slice(1, -1) : raw)
  if (!isLocalImagePath(path)) return null
  // 用原本的檔名找：指到的不是這次匯入的圖片就不管
  const target = resolveImagePath(spaces.before, folder, path)
  const moved = target && spaces.after.byId.get(target.id)
  if (!target || !moved) return null
  // 用建立的名稱還找得到同一張圖片就不改（保留原本的寫法）。/ 開頭的指到 App 的最上層，匯入的位置不一定是最上層，一律改成相對路徑
  if (!path.startsWith('/') && resolveImagePath(spaces.after, folder, path)?.id === target.id) return null
  return markdownLinkTarget(relativeImagePath(spaces.after, folder, moved))
}

/**
 * 改寫筆記裡指到匯入圖片的連結（![](…) 與參考式連結的定義），換成圖片匯入後的名稱與位置。
 * folder 是筆記所在資料夾的路徑（null 為匯入的位置）。程式碼裡的不改；指到其他地方的連結、網址不改
 */
export function rewriteImageLinks(content: string, folder: string | null, spaces: LinkSpaces): string {
  const masked = maskCode(content)
  const edits: { start: number; end: number; text: string }[] = []
  for (const pattern of [IMAGE_LINK, REFERENCE_DEFINITION]) {
    for (const match of masked.matchAll(pattern)) {
      const end = match.index + match[0].length
      const start = end - match[1].length
      const text = retarget(content.slice(start, end), folder, spaces)
      if (text !== null) edits.push({ start, end, text })
    }
  }
  edits.sort((a, b) => b.start - a.start)
  let result = content
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}
