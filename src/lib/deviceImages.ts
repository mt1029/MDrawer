// 這台裝置上還沒上傳的圖片（離線時插入的，存在 IndexedDB 的 files）用 blob: 網址顯示。
// CSP 的 img-src 為此加上 blob:，但 DOMPurify 只放行這裡產生的網址（markdown.ts），
// 筆記裡自己寫的 blob: 網址照樣被移除。
//
// 網址在這次開啟 App 期間不撤銷：同步上傳後畫面可能還在用（撤銷的話預覽重畫時會讀不到）；
// 登出時全部撤銷。

/** 圖片檔 id → blob: 網址 */
const byFile = new Map<string, string>()
/** 這裡產生過的網址 */
const issued = new Set<string>()

/** 這張圖片的 blob: 網址（同一個圖片檔只產生一次） */
export function deviceImageUrl(fileId: string, blob: Blob): string {
  let url = byFile.get(fileId)
  if (!url) {
    url = URL.createObjectURL(blob)
    byFile.set(fileId, url)
    issued.add(url)
  }
  return url
}

/** 是不是這裡產生的 blob: 網址（DOMPurify 只放行這些） */
export function isDeviceImageUrl(url: string): boolean {
  return issued.has(url)
}

/** 撤銷全部的網址（登出時） */
export function revokeDeviceImageUrls(): void {
  for (const url of issued) URL.revokeObjectURL(url)
  byFile.clear()
  issued.clear()
}
