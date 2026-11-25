// ZIP 匯出：讀取所有資料夾、筆記與圖片，照原本的目錄結構打包下載。
// 解壓後是一般的 .md 檔與圖片，用任何 Markdown 編輯器都能直接看（spec 第 3 節標準層）。

import { buildZip, imageExtension, planExport } from './exportPlan.ts'
import { extractImageIds } from './markdown.ts'
import { RepoError, repo } from './repo.ts'

export type ExportProgress =
  | { stage: 'notes' }
  | { stage: 'images'; done: number; total: number }
  | { stage: 'zip' }

export interface ExportResult {
  blob: Blob
  fileName: string
  folderCount: number
  noteCount: number
  imageCount: number
  /** 找不到、沒有下載成功的圖片 id */
  missingImages: string[]
}

// 同時下載幾張圖片
const DOWNLOAD_CONCURRENCY = 4

function todayStamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export async function exportAll(onProgress: (progress: ExportProgress) => void): Promise<ExportResult> {
  if (!navigator.onLine) throw new RepoError('network', '離線時無法匯出，請連線後再試。')

  onProgress({ stage: 'notes' })
  const nodes = await repo.listAll()
  const imageIds = [...new Set(nodes.flatMap((node) => (node.type === 'note' ? extractImageIds(node.content ?? '') : [])))]

  // 下載圖片：找不到的記下來繼續；斷線則整個匯出失敗
  const images = new Map<string, Blob>()
  const missingImages: string[] = []
  let done = 0
  onProgress({ stage: 'images', done, total: imageIds.length })
  const queue = [...imageIds]
  async function worker() {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        images.set(id, await repo.downloadImage(id))
      } catch (err) {
        if (err instanceof RepoError && err.kind === 'network') throw err
        missingImages.push(id)
      }
      onProgress({ stage: 'images', done: ++done, total: imageIds.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, imageIds.length) }, worker))

  onProgress({ stage: 'zip' })
  const plan = planExport(nodes, (id) => imageExtension(images.get(id)?.type ?? ''))
  const blob = await buildZip(plan, images)

  return {
    blob,
    fileName: `MDrawer-${todayStamp()}.zip`,
    folderCount: plan.folders.length,
    noteCount: plan.notes.length,
    imageCount: images.size,
    missingImages,
  }
}

/** 讓瀏覽器把 Blob 存成檔案 */
export function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  // 給瀏覽器時間開始下載後再釋放
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
