// 匯入：讀取選到、拖進來的檔案與資料夾（ZIP 先展開），再依 importPlan.ts 的規劃建立資料夾、圖片、筆記。
//
// 順序是資料夾 → 圖片 → 筆記：圖片建立後才知道名稱（壓縮後的副檔名、撞名的編號），筆記裡的連結才能跟著改。
// 撞名一律自動加「 (2)」，不覆蓋、不合併已有的項目。筆記與資料夾離線也可以匯入（先存本機，連線後同步）；
// 圖片要上傳，離線時略過。

import { ImageError, type CompressedImage } from './image.ts'
import {
  importKind,
  imageTypeOf,
  linkSpaces,
  rewriteImageLinks,
  splitImportPath,
  type ImportFile,
  type ImportPlan,
  type PlannedEntry,
} from './importPlan.ts'
import { RepoError, imageFileName, type NodeMeta } from './nodes.ts'
import type { Repo } from './repo.ts'
import { strings } from '../strings.ts'

/** 一次最多讀幾個檔案（含不支援的）：避免不小心拖進很大的資料夾，讀很久或用光記憶體 */
export const MAX_IMPORT_FILES = 1000

/** 讀取失敗、檔案太多等，message 可直接顯示 */
export class ImportError extends Error {}

export interface ImportFailure {
  /** 檔案的路徑 */
  name: string
  message: string
}

/** 讀到的東西 */
export interface ImportSource {
  files: ImportFile[]
  /** 資料夾（可能是空的） */
  folders: string[]
  /** 讀不到的檔案、壞掉的 ZIP */
  failed: ImportFailure[]
}

function checkCount(count: number) {
  if (count > MAX_IMPORT_FILES) throw new ImportError(strings.imports.tooMany(MAX_IMPORT_FILES))
}

/** <input type="file"> 選到的檔案。選資料夾時 webkitRelativePath 是「資料夾/子資料夾/檔名」 */
export function filesFromInput(files: File[]): ImportSource {
  checkCount(files.length)
  return { files: files.map((file) => ({ path: file.webkitRelativePath || file.name, file })), folders: [], failed: [] }
}

/** 拖進來的項目。一定要在 drop 事件裡呼叫：事件結束後就讀不到了 */
export function entriesFromDrop(data: DataTransfer): (FileSystemEntry | File)[] {
  const entries: (FileSystemEntry | File)[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    // 不支援 webkitGetAsEntry 的瀏覽器只能拿到檔案（拖資料夾進來時讀不到裡面）
    const entry = item.webkitGetAsEntry?.()
    const file = entry ? null : item.getAsFile()
    if (entry) entries.push(entry)
    else if (file) entries.push(file)
  }
  return entries
}

const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory
const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile

/** 資料夾裡的所有項目（readEntries 一次最多回傳 100 個，要一直讀到空的為止） */
async function readDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

/** 讀出拖進來的檔案與資料夾（資料夾裡的全部，包含空的資料夾；隱藏的資料夾不讀） */
export async function readDropped(entries: (FileSystemEntry | File)[]): Promise<ImportSource> {
  const source: ImportSource = { files: [], folders: [], failed: [] }

  async function walk(entry: FileSystemEntry) {
    const path = entry.fullPath.replace(/^\/+/, '') || entry.name
    if (!splitImportPath(path)) return
    if (isDirectory(entry)) {
      source.folders.push(path)
      let children: FileSystemEntry[]
      try {
        children = await readDirectory(entry)
      } catch {
        source.failed.push({ name: path, message: strings.imports.readFailed })
        return
      }
      for (const child of children) await walk(child)
    } else if (isFile(entry)) {
      checkCount(source.files.length + 1)
      try {
        source.files.push({ path, file: await new Promise<File>((resolve, reject) => entry.file(resolve, reject)) })
      } catch {
        source.failed.push({ name: path, message: strings.imports.readFailed })
      }
    }
  }

  for (const entry of entries) {
    if (entry instanceof File) {
      checkCount(source.files.length + 1)
      source.files.push({ path: entry.name, file: entry })
    } else {
      await walk(entry)
    }
  }
  return source
}

/** 讀出 ZIP 裡的檔案與資料夾。不支援的檔案不解壓縮（只需要路徑，算略過幾個） */
async function readZip(blob: Blob): Promise<{ files: ImportFile[]; folders: string[] }> {
  // JSZip 只有匯入、匯出時才用到，需要時才載入
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const entries = Object.values(zip.files)
  const fileEntries = entries.filter((entry) => !entry.dir && splitImportPath(entry.name))
  checkCount(fileEntries.length)
  const files = await Promise.all(
    fileEntries.map(async (entry) => ({
      path: entry.name,
      file: importKind(entry.name) === 'other' ? new Blob() : new Blob([await entry.async('arraybuffer')]),
    })),
  )
  return { files, folders: entries.filter((entry) => entry.dir).map((entry) => entry.name) }
}

/**
 * 展開直接選到、拖進來的 .zip（資料夾裡的 .zip 不展開，當成不支援的檔案）。
 * ZIP 裡只有一個最上層的資料夾時，匯入成那個資料夾；不然放進以 ZIP 檔名命名的資料夾，不跟匯入位置原有的東西混在一起
 */
export async function expandZips(source: ImportSource): Promise<ImportSource> {
  const result: ImportSource = { files: [], folders: [...source.folders], failed: [...source.failed] }
  for (const item of source.files) {
    const segments = splitImportPath(item.path)
    if (!segments || segments.length !== 1 || !/\.zip$/i.test(segments[0])) {
      result.files.push(item)
      continue
    }
    let content: Awaited<ReturnType<typeof readZip>>
    try {
      content = await readZip(item.file)
    } catch (err) {
      if (err instanceof ImportError) throw err
      result.failed.push({ name: segments[0], message: strings.imports.badZip })
      continue
    }
    // 每個項目最上層的名稱（忽略的不算）；全部一樣、而且沒有檔案直接放在最上層，就是只有一個資料夾
    const tops = new Set(
      [...content.files.map((file) => file.path), ...content.folders].flatMap((path) => splitImportPath(path)?.[0] ?? []),
    )
    const oneFolder = tops.size === 1 && content.files.every((file) => (splitImportPath(file.path)?.length ?? 2) > 1)
    const prefix = oneFolder ? '' : `${segments[0].replace(/\.zip$/i, '')}/`
    if (prefix) result.folders.push(prefix)
    result.files.push(...content.files.map((file) => ({ path: prefix + file.path, file: file.file })))
    result.folders.push(...content.folders.map((folder) => prefix + folder))
    checkCount(result.files.length)
  }
  return result
}

export interface ImportDeps {
  repo: Pick<Repo, 'createNode' | 'uploadImage'>
  /** 壓縮圖片（compressImage；測試時換成假的） */
  compress: (file: Blob) => Promise<Pick<CompressedImage, 'blob' | 'format'>>
  /** 每建立（或失敗）一個項目呼叫一次 */
  onProgress?: (done: number, total: number) => void
}

export interface ImportResult {
  folders: number
  notes: number
  images: number
  /** 不支援的檔案 */
  skipped: number
  failed: ImportFailure[]
  /** 直接放在匯入位置的項目（匯入後選取） */
  created: NodeMeta[]
}

function messageOf(err: unknown): string {
  return err instanceof RepoError || err instanceof ImageError || err instanceof ImportError
    ? err.message
    : strings.common.unexpectedTryAgain
}

/** 依規劃建立項目，放進 targetId 資料夾（null 為最上層）。一個失敗不影響其他的 */
export async function runImport(plan: ImportPlan, targetId: string | null, deps: ImportDeps): Promise<ImportResult> {
  const result: ImportResult = {
    folders: 0,
    notes: 0,
    images: 0,
    skipped: plan.skipped.length,
    failed: [],
    created: [],
  }
  // 原本的路徑 → 建立的資料夾 id；原本的路徑 → 建立的名稱（資料夾與圖片，改寫連結用）
  const folderIds = new Map<string, string>()
  const names = new Map<string, string>()
  const total = plan.folders.length + plan.notes.length + plan.images.length
  let done = 0

  /** 建立一個項目：上層資料夾沒有建立時不建立；失敗時記下原因 */
  async function create(entry: PlannedEntry, make: (parentId: string | null) => Promise<NodeMeta>): Promise<NodeMeta | null> {
    const parentId = entry.parent === null ? targetId : folderIds.get(entry.parent)
    let node: NodeMeta | null = null
    if (parentId === undefined) {
      result.failed.push({ name: entry.path, message: strings.imports.parentFailed })
    } else {
      try {
        node = await make(parentId)
        if (entry.parent === null) result.created.push(node)
      } catch (err) {
        result.failed.push({ name: entry.path, message: messageOf(err) })
      }
    }
    deps.onProgress?.(++done, total)
    return node
  }

  for (const folder of plan.folders) {
    const node = await create(folder, (parentId) =>
      deps.repo.createNode({ parentId, type: 'folder', name: folder.name, rename: true }),
    )
    if (!node) continue
    folderIds.set(folder.path, node.id)
    names.set(folder.path, node.name)
    result.folders++
  }

  // 離線時圖片先存在這台裝置，同步時才上傳（repo.uploadImage）
  for (const image of plan.images) {
    const node = await create(image, async (parentId) => {
      // ZIP 裡的檔案沒有類型，依副檔名補上（壓縮前會檢查是不是圖片）
      const type = image.file.type.startsWith('image/') ? image.file.type : (imageTypeOf(image.name) ?? '')
      const compressed = await deps.compress(image.file.type === type ? image.file : new Blob([image.file], { type }))
      const fileId = await deps.repo.uploadImage(compressed.blob)
      return deps.repo.createNode({
        parentId,
        type: 'image',
        name: imageFileName(image.name, compressed.format),
        content: fileId,
        rename: true,
      })
    })
    if (!node) continue
    names.set(image.path, node.name)
    result.images++
  }

  const spaces = linkSpaces(plan, names)
  for (const note of plan.notes) {
    const node = await create(note, async (parentId) => {
      // 統一成 \n 換行（Windows 的檔案是 \r\n）
      const text = (
        await note.file.text().catch(() => {
          throw new ImportError(strings.imports.readFailed)
        })
      ).replace(/\r\n?/g, '\n')
      const content = rewriteImageLinks(text, note.parent, spaces)
      return deps.repo.createNode({ parentId, type: 'note', name: note.name, content, rename: true })
    })
    if (node) result.notes++
  }
  return result
}
