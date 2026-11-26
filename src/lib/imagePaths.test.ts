import { describe, expect, it } from 'vitest'
import {
  createPathIndex,
  decodeImagePath,
  isLocalImagePath,
  markdownLinkTarget,
  relativeImagePath,
  resolveImagePath,
} from './imagePaths.ts'
import type { NodeType } from './nodes.ts'

const node = (id: string, parent_id: string | null, type: NodeType, name: string) => ({ id, parent_id, type, name })

// /課程/第一週/筆記、/課程/第一週/架構圖.webp、/課程/共用/logo.webp、/首頁.webp、/課程/圖 (1).webp
const nodes = [
  node('course', null, 'folder', '課程'),
  node('week', 'course', 'folder', '第一週'),
  node('shared', 'course', 'folder', '共用'),
  node('note', 'week', 'note', '筆記'),
  node('diagram', 'week', 'image', '架構圖.webp'),
  node('logo', 'shared', 'image', 'Logo.webp'),
  node('home', null, 'image', '首頁.webp'),
  node('spaced', 'course', 'image', '圖 (1).webp'),
]
const index = createPathIndex(nodes)
const resolve = (from: string | null, path: string) => resolveImagePath(index, from, path)?.id ?? null

describe('isLocalImagePath', () => {
  it('網址、img:、data:、// 開頭、# 開頭不是資料夾裡的路徑', () => {
    for (const src of ['https://example.com/a.png', 'img:aaaa', 'data:image/png;base64,AA', 'javascript:alert(1)', '//cdn/a.png', '#x', ''])
      expect(isLocalImagePath(src), src).toBe(false)
    for (const src of ['a.webp', '../a.webp', '/課程/a.webp', '%E5%9C%96.webp']) expect(isLocalImagePath(src), src).toBe(true)
  })

  it('markdown-it 編碼過的路徑可以解回來；壞掉的編碼照原樣', () => {
    expect(decodeImagePath('%E6%9E%B6%E6%A7%8B%E5%9C%96.webp')).toBe('架構圖.webp')
    expect(decodeImagePath('%E5%9C%96%20(1).webp')).toBe('圖 (1).webp')
    expect(decodeImagePath('%E0%A4%A')).toBe('%E0%A4%A')
  })
})

describe('resolveImagePath', () => {
  it('同一個資料夾、子資料夾、上一層、從最上層', () => {
    expect(resolve('week', '架構圖.webp')).toBe('diagram')
    expect(resolve('week', './架構圖.webp')).toBe('diagram')
    expect(resolve('course', '第一週/架構圖.webp')).toBe('diagram')
    expect(resolve('week', '../共用/Logo.webp')).toBe('logo')
    expect(resolve('week', '/課程/共用/Logo.webp')).toBe('logo')
    expect(resolve('week', '../../首頁.webp')).toBe('home')
    expect(resolve(null, '首頁.webp')).toBe('home')
  })

  it('名稱不分大小寫', () => {
    expect(resolve('shared', 'logo.WEBP')).toBe('logo')
  })

  it('找不到、指到資料夾或筆記、超出最上層時回傳 null', () => {
    expect(resolve('week', '不存在.webp')).toBeNull()
    expect(resolve('week', '筆記')).toBeNull()
    expect(resolve('course', '第一週')).toBeNull()
    expect(resolve('week', '筆記/架構圖.webp')).toBeNull() // 筆記不是資料夾
    expect(resolve(null, '../首頁.webp')).toBeNull()
    expect(resolve('week', '第一週/')).toBeNull()
  })
})

describe('relativeImagePath 與 markdownLinkTarget', () => {
  const rel = (from: string | null, target: string) => relativeImagePath(index, from, index.byId.get(target)!)

  it('從筆記所在的資料夾到圖片的相對路徑', () => {
    expect(rel('week', 'diagram')).toBe('架構圖.webp')
    expect(rel('week', 'logo')).toBe('../共用/Logo.webp')
    expect(rel('week', 'home')).toBe('../../首頁.webp')
    expect(rel(null, 'diagram')).toBe('課程/第一週/架構圖.webp')
    expect(rel('course', 'spaced')).toBe('圖 (1).webp')
  })

  it('算出來的路徑解析回同一張圖片', () => {
    for (const from of [null, 'course', 'week', 'shared']) {
      for (const target of ['diagram', 'logo', 'home', 'spaced']) expect(resolve(from, rel(from, target))).toBe(target)
    }
  })

  it('有空白或括號時用 <…> 包起來', () => {
    expect(markdownLinkTarget('架構圖.webp')).toBe('架構圖.webp')
    expect(markdownLinkTarget('圖 (1).webp')).toBe('<圖 (1).webp>')
    expect(markdownLinkTarget('a<b>.webp')).toBe('<a%3Cb%3E.webp>')
  })
})
