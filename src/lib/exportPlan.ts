// ZIP 匯出的「規劃」部分：決定每個資料夾、筆記、圖片在 ZIP 裡的路徑，並把筆記裡的
// img:<id> 改成相對路徑。不讀寫資料，方便單元測試；讀資料與下載在 export.ts。

import { rewriteImageRefs } from './markdown.ts'
import type { TreeNode } from './nodes.ts'

/** 圖片放在 ZIP 根目錄的這個資料夾 */
export const IMAGES_DIR = 'images'

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

export interface ExportPlan {
  folders: ExportFolder[]
  notes: ExportNote[]
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' })

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return collator.compare(a.name, b.name)
}

/**
 * 依資料夾樹排出 ZIP 裡的路徑。
 * @param extensionOf 圖片 id → 副檔名（webp 或 jpg），用來組成圖片的相對路徑
 */
export function planExport(nodes: TreeNode[], extensionOf: (imageId: string) => string): ExportPlan {
  const plan: ExportPlan = { folders: [], notes: [] }
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

    // 名稱已經以 .md 結尾時不再重複加
    const file = names.claim(toSafeFileName(node.name.replace(/\.md$/i, '')), '.md')
    // 圖片都在根目錄的 images/，從筆記所在的資料夾往上回到根目錄
    const toRoot = '../'.repeat(dir.length)
    const content = rewriteImageRefs(node.content ?? '', (id) => `${toRoot}${IMAGES_DIR}/${id}.${extensionOf(id)}`)
    plan.notes.push({ path: [...dir, file].join('/'), content, date })
  }

  const rootNames = new NameRegistry()
  rootNames.claim(IMAGES_DIR) // 保留給圖片資料夾，使用者的「images」資料夾會變成「images (2)」
  for (const node of childrenOf.get(null) ?? []) place(node, [], rootNames)
  // 兩台裝置同時移動可能造成循環，循環裡的項目從最上層走不到，也放到最上層，避免漏掉
  for (const node of [...nodes].sort(compareNodes)) {
    if (!visited.has(node.id)) place(node, [], rootNames)
  }
  return plan
}

/** 依規劃把筆記、資料夾與圖片打包成 ZIP */
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
  for (const [id, blob] of images) {
    // 圖片已經壓縮過，不必再壓
    zip.file(`${IMAGES_DIR}/${id}.${imageExtension(blob.type)}`, blob, { compression: 'STORE' })
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' })
}
