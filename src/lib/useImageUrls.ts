import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPathIndex, resolveImagePath, type PathIndex } from './imagePaths.ts'
import { extractImagePaths, type ImageResolver } from './markdown.ts'
import { repo, type TreeNode } from './repo.ts'

export interface ImageUrlOptions {
  /** 筆記所在的資料夾（null 為最上層）：相對路徑從這裡算起 */
  folderId: string | null
  /** 資料有變（上傳、改名、移動、同步）時改變：重新讀取資料夾裡的圖片 */
  version: number
  /** 預覽看得到時才處理（看不到時不讀資料、不取網址） */
  active: boolean
  /** 連線且已登入：才能取得雲端圖片的網址 */
  online: boolean
}

/**
 * 筆記裡的圖片（相對路徑）→ 網址，給 renderMarkdown 的 resolveImage 用。
 * 回傳值：string 為網址、null 為找不到、undefined 為還在取得（離線時為拿不到）。
 *
 * 先用這台裝置的資料找到路徑指的圖片項目（離線也可以），再用它的圖片檔 id 取網址：
 * 雲端上的是簽名網址；離線時插入、還沒上傳的是 blob: 網址（只有 App 產生的能通過 DOMPurify，見 deviceImages.ts）。
 *
 * 離線時只拿得到這台裝置上的；恢復連線時，把還沒有網址的圖片補上。
 */
export function useImageUrls(source: string, { folderId, version, active, online }: ImageUrlOptions): ImageResolver {
  // 圖片檔 id → 網址（null 為檔案不存在）
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const pending = useRef(new Set<string>())
  // 這台裝置上的資料夾與圖片，用來解析相對路徑
  const [index, setIndex] = useState<PathIndex<TreeNode> | null>(null)

  const paths = useMemo(() => (active ? extractImagePaths(source) : []), [source, active])
  const hasPaths = paths.length > 0

  useEffect(() => {
    if (!active || !hasPaths) return
    let cancelled = false
    repo
      .listAll()
      .then((nodes) => {
        if (!cancelled) setIndex(createPathIndex(nodes))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active, hasPaths, version])

  // 路徑 → 圖片檔 id（null 為找不到圖片項目）；資料還沒讀到時為 null
  const fileOfPath = useMemo(() => {
    if (!index) return null
    return new Map(paths.map((path) => [path, resolveImagePath(index, folderId, path)?.content ?? null]))
  }, [index, paths, folderId])

  const fileIds = useMemo(
    () => [...new Set([...(fileOfPath?.values() ?? [])].filter((id): id is string => id !== null))],
    [fileOfPath],
  )

  // online 變了（恢復連線）時重新執行，補上離線時拿不到的
  useEffect(() => {
    const missing = fileIds.filter((id) => !(id in urls) && !pending.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) pending.current.add(id)
    repo
      .getImageUrls(missing)
      // 離線時拿不到的不會列出；什麼都沒拿到就不更新，免得一直重新執行
      .then((result) => {
        if (Object.keys(result).length > 0) setUrls((prev) => ({ ...prev, ...result }))
      })
      // 失敗（例如斷線）時不記錄，之後內容變動會再試一次
      .catch(() => undefined)
      .finally(() => {
        for (const id of missing) pending.current.delete(id)
      })
  }, [fileIds, urls, online])

  return useCallback<ImageResolver>(
    (path) => {
      if (!fileOfPath) return undefined
      const fileId = fileOfPath.get(path)
      return fileId ? urls[fileId] : null
    },
    [urls, fileOfPath],
  )
}
