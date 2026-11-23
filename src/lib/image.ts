// 貼圖壓縮：用 Canvas 縮小並轉成 WebP。
// Safari（含所有 iPhone 瀏覽器）的 Canvas 無法輸出 WebP，會默默改成 PNG，所以改存 JPEG。

export type ImageFormat = 'image/webp' | 'image/jpeg'

export interface CompressedImage {
  blob: Blob
  format: ImageFormat
  width: number
  height: number
  originalBytes: number
}

/** 壓縮失敗的原因，message 可直接顯示 */
export class ImageError extends Error {}

// 長邊上限。截圖縮到這個大小，文字仍然清楚
const MAX_DIMENSION = 2560
// 與 Storage bucket 的 file_size_limit 一致
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
// 超過大小就降低品質重試，還是太大再縮小尺寸
const QUALITIES = [0.8, 0.65, 0.5]
const SHRINK_STEPS = 4

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ImageError('圖片轉檔失敗。'))), type, quality)
  })
}

let webpSupport: Promise<boolean> | undefined

/** 這個瀏覽器能不能把 Canvas 輸出成 WebP（不支援時 toBlob 會回傳 PNG） */
export function canEncodeWebp(): Promise<boolean> {
  if (!webpSupport) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    webpSupport = canvasToBlob(canvas, 'image/webp')
      .then((blob) => blob.type === 'image/webp')
      .catch(() => false)
  }
  return webpSupport
}

/** 縮小並轉成 WebP（不支援時用 JPEG），確保不超過 2 MB */
export async function compressImage(file: Blob): Promise<CompressedImage> {
  if (!file.type.startsWith('image/')) throw new ImageError('只能插入圖片檔。')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageError('無法讀取這張圖片，這個瀏覽器可能不支援它的格式。')
  }

  try {
    const format: ImageFormat = (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg'
    let scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))

    for (let step = 0; step < SHRINK_STEPS; step++) {
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new ImageError('這個瀏覽器無法處理圖片。')
      if (format === 'image/jpeg') {
        // JPEG 沒有透明度，先鋪白底，避免透明處變成黑色
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
      }
      context.drawImage(bitmap, 0, 0, width, height)

      for (const quality of QUALITIES) {
        const blob = await canvasToBlob(canvas, format, quality)
        if (blob.type !== format) throw new ImageError('圖片轉檔失敗。')
        if (blob.size <= MAX_IMAGE_BYTES) {
          return { blob, format, width, height, originalBytes: file.size }
        }
      }
      scale *= 0.75
    }
    throw new ImageError('圖片太大，壓縮後仍超過 2 MB。')
  } finally {
    bitmap.close()
  }
}

/** 1536 → "1.5 KB"，2400000 → "2.3 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
