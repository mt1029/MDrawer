// ZIP 匯出的「規劃」部分：決定每個資料夾、筆記、圖片在 ZIP 裡的路徑。
// 不讀寫資料，方便單元測試；讀資料與下載在 export.ts。
//
// 圖片跟筆記一樣放在它所在的資料夾，筆記照原樣存成 .md：筆記用相對路徑引用圖片（![](架構圖.webp)），
// ZIP 裡的位置跟 App 裡一樣，連結不用改。

import type { TreeNode } from './nodes.ts'

const EXTENSIONS: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg' }

/** 依圖片格式決定副檔名；不認得的格式當成 WebP */
export function imageExtension(type: string): string {
  return EXTENSIONS[type] ?? 'webp'
}

// Windows、macOS 檔名不允許的字元，以及 Windows 的保留名稱
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g // oxlint-disable-line no-control-regex -- 控制字元不能出現在檔名
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 把名稱轉成各作業系統都能用的檔名（spec 第 7 節：匯出時再淨化一次） */
export function toSafeFileName(name: string): string {
  let safe = name
    .normalize('NFC')
    .replace(ILLEGAL_CHARS, '_')
    // Windows 會自動去掉結尾的點與空白，先去掉以免撞名
    .replace(/[. ]+$/, '')
  if (safe === '') safe = '_'
  if (RESERVED_NAMES.test(safe)) safe = `_${safe}`
  return safe
}

/** 記錄同一個資料夾裡已用過的名稱（不分大小寫），重複時加上「 (2)」 */
class NameRegistry {
  private used = new Set<string>()

  claim(base: string, extension = ''): string {
    let candidate = base + extension
    for (let n = 2; this.used.has(candidate.toLowerCase()); n++) {
      candidate = `${base} (${n})${extension}`
    }
    this.used.add(candidate.toLowerCase())
    return candidate
  }
}

export interface ExportFolder {
  path: string
  date: Date
}

export interface ExportNote {
  path: string
  content: string
  date: Date
}

export interface ExportImage {
  path: string
  /** 圖片檔的 id（Storage） */
  fileId: string
  date: Date
}

export interface ExportPlan {
  folders: ExportFolder[]
  notes: ExportNote[]
  images: ExportImage[]
}

/** 名稱拆成主檔名與圖片副檔名（沒有認得的副檔名時，副檔名是空字串） */
function splitImageName(name: string): [base: string, extension: string] {
  const match = /\.(webp|jpe?g)$/i.exec(name)
  return match ? [name.slice(0, match.index), match[0]] : [name, '']
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' })

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return collator.compare(a.name, b.name)
}

/**
 * 依資料夾樹排出 ZIP 裡的路徑。
 * @param extensionOf 圖片檔 id → 副檔名（webp 或 jpg），圖片的名稱沒有副檔名時用
 */
export function planExport(nodes: TreeNode[], extensionOf: (fileId: string) => string): ExportPlan {
  const plan: ExportPlan = { folders: [], notes: [], images: [] }
  const ids = new Set(nodes.map((node) => node.id))
  const childrenOf = new Map<string | null, TreeNode[]>()
  for (const node of nodes) {
    // 上層資料夾不在清單裡（例如已被刪除）時，放到最上層
    const parentId = node.parent_id && ids.has(node.parent_id) ? node.parent_id : null
    const list = childrenOf.get(parentId) ?? []
    list.push(node)
    childrenOf.set(parentId, list)
  }
  for (const list of childrenOf.values()) list.sort(compareNodes)

  const visited = new Set<string>()

  function place(node: TreeNode, dir: string[], names: NameRegistry) {
    if (visited.has(node.id)) return
    visited.add(node.id)
    const date = new Date(node.updated_at)

    if (node.type === 'folder') {
      const path = [...dir, names.claim(toSafeFileName(node.name))]
      plan.folders.push({ path: path.join('/'), date })
      const childNames = new NameRegistry()
      for (const child of childrenOf.get(node.id) ?? []) place(child, path, childNames)
      return
    }

    if (node.type === 'image') {
      // 名稱已經有副檔名（.webp、.jpg）就照用，沒有的話依圖片檔的格式加上
      const fileId = node.content ?? ''
      const [base, extension] = splitImageName(node.name)
      const file = names.claim(toSafeFileName(base), extension || `.${extensionOf(fileId)}`)
      plan.images.push({ path: [...dir, file].join('/'), fileId, date })
      return
    }

    // 名稱已經以 .md 結尾時不再重複加
    const file = names.claim(toSafeFileName(node.name.replace(/\.md$/i, '')), '.md')
    plan.notes.push({ path: [...dir, file].join('/'), content: node.content ?? '', date })
  }

  const rootNames = new NameRegistry()
  for (const node of childrenOf.get(null) ?? []) place(node, [], rootNames)
  // 兩台裝置同時移動可能造成循環，循環裡的項目從最上層走不到，也放到最上層，避免漏掉
  for (const node of [...nodes].sort(compareNodes)) {
    if (!visited.has(node.id)) place(node, [], rootNames)
  }
  return plan
}

/** 依規劃把筆記、資料夾與圖片打包成 ZIP。images 是圖片檔 id → 下載的檔案，沒有的（找不到）略過 */
export async function buildZip(plan: ExportPlan, images: Map<string, Blob>): Promise<Blob> {
  // JSZip 只有匯出時才用到，需要時才載入，不放進主程式
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const folder of plan.folders) {
    zip.file(folder.path, null, { dir: true, date: folder.date })
  }
  for (const note of plan.notes) {
    zip.file(note.path, note.content, { date: note.date })
  }
  // 圖片已經壓縮過，不必再壓
  for (const image of plan.images) {
    const blob = images.get(image.fileId)
    if (blob) zip.file(image.path, blob, { date: image.date, compression: 'STORE' })
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' })
}
