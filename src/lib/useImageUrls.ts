import { useEffect, useRef, useState } from 'react'
import { extractImageIds } from './markdown.ts'
import { repo } from './repo.ts'

/**
 * 取得筆記裡 img:<id> 圖片的簽名網址。
 * 回傳值：string 為網址、null 為圖片不存在、沒有 key 代表還在取得。
 *
 * 剛貼上的圖片也是上傳後再取簽名網址，不用本機的 blob: 網址：
 * DOMPurify 預設會移除 blob: 網址，圖片會顯示不出來。
 *
 * enabled 為 false（離線）時不取網址；恢復連線變回 true 時，把還沒有網址的圖片補上。
 */
export function useImageUrls(source: string, enabled = true): Record<string, string | null> {
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const pending = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled) return
    const missing = extractImageIds(source).filter((id) => !(id in urls) && !pending.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) pending.current.add(id)
    repo
      .getImageUrls(missing)
      .then((result) => setUrls((prev) => ({ ...prev, ...result })))
      // 失敗（例如斷線）時不記錄，之後內容變動會再試一次
      .catch(() => undefined)
      .finally(() => {
        for (const id of missing) pending.current.delete(id)
      })
  }, [source, urls, enabled])

  return urls
}
