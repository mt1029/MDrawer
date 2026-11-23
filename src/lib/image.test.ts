import { describe, expect, it } from 'vitest'
import { formatBytes } from './image.ts'

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
