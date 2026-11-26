import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_BYTES, formatBytes, keepOrCompress, type CompressedImage } from './image.ts'

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [184_320, '180 KB'],
    [2_400_000, '2.3 MB'],
  ])('%i → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

describe('keepOrCompress', () => {
  // 測試環境沒有圖片解碼：內容是「壞掉」的讀不出來，其他的當成 size 大小的圖片
  function decodeAs(size: { width: number; height: number }) {
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
      if ((await blob.text()) === '壞掉') throw new Error('InvalidStateError')
      return { ...size, close() {} }
    })
  }
  const compressed: CompressedImage = { blob: new Blob(['壓縮後']), format: 'image/webp', width: 1, height: 1, originalBytes: 1 }
  const compress = vi.fn(async () => compressed)
  afterEach(() => {
    vi.unstubAllGlobals()
    compress.mockClear()
  })

  it('WebP、JPEG 不超過上限時照原樣用，不重新壓縮', async () => {
    decodeAs({ width: 2560, height: 1440 })
    for (const type of ['image/webp', 'image/jpeg'] as const) {
      const blob = new Blob(['圖'], { type })
      expect(await keepOrCompress(blob, compress)).toMatchObject({ blob, format: type, width: 2560, height: 1440 })
    }
    expect(compress).not.toHaveBeenCalled()
  })

  it('其他格式、太大、尺寸超過、讀不出來的都壓縮', async () => {
    decodeAs({ width: 2561, height: 100 })
    const cases = [
      new Blob(['圖'], { type: 'image/png' }),
      new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: 'image/webp' }),
      new Blob(['圖'], { type: 'image/jpeg' }), // 2561 寬
      new Blob(['壞掉'], { type: 'image/webp' }),
    ]
    for (const blob of cases) expect(await keepOrCompress(blob, compress)).toBe(compressed)
    expect(compress).toHaveBeenCalledTimes(cases.length)
  })
})
