// Markdown 解析與 XSS 過濾。畫面上顯示筆記內容一律經過 renderMarkdown。
// 兩道防線：
//   1. markdown-it 設 html: false：筆記裡的 HTML 標籤當成純文字顯示，不會變成真的元素
//   2. DOMPurify：再過濾一次輸出，移除事件屬性、javascript: 等危險網址

import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { strings } from '../strings.ts'
import { isDeviceImageUrl } from './deviceImages.ts'
import { decodeImagePath, isLocalImagePath } from './imagePaths.ts'

const md = new MarkdownIt({
  html: false, // 不允許原始 HTML（CLAUDE.md 規定）
  linkify: true, // 把純文字網址轉成連結
  typographer: false,
})

/**
 * 把筆記裡圖片的相對路徑（已解碼，例如「../圖/架構圖.webp」）換成可顯示的網址。
 * 圖片放在資料夾裡，筆記用相對路徑引用（![](架構圖.webp)，見 imagePaths.ts）。
 * - string：網址
 * - null：找不到圖片
 * - undefined：還在取得中
 */
export type ImageResolver = (path: string) => string | null | undefined

export interface RenderOptions {
  /** 離線中：還沒取得網址的圖片顯示「離線時無法載入圖片」，而不是載入中的佔位框 */
  offline?: boolean
  /** 圖片的相對路徑換成網址。沒有傳的話，這類圖片一律當成找不到 */
  resolveImage?: ImageResolver
}

// 用 type 而不是 interface，才能當成 markdown-it 的 env（需要索引簽章）
type RenderEnv = { offline?: boolean; resolveImage?: ImageResolver }

// 文字來自 strings.ts，不含筆記內容；仍先跳脫成純文字，之後也會再經過 DOMPurify
const OFFLINE_IMAGE = `<span class="img-offline">${md.utils.escapeHtml(strings.markdown.offlineImage)}</span>`

// 在 markdown-it 產生 <img> 時就把資料夾裡的圖片（相對路徑）換成 Storage 的簽名網址。
// 不換的話瀏覽器會把相對路徑當成這個網站的網址去讀，讀不到。
// 換上的網址之後仍會經過 DOMPurify，就算網址有問題也會被擋下。
const renderImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const src = String(token.attrGet('src') ?? '')
  const { resolveImage, offline } = (env as RenderEnv | undefined) ?? {}
  if (isLocalImagePath(src)) {
    const url = resolveImage ? resolveImage(decodeImagePath(src)) : null
    if (url === undefined && offline) return OFFLINE_IMAGE
    if (url) {
      token.attrSet('src', url)
    } else {
      // 取得中或取不到：拿掉 src，加上 class 讓畫面顯示佔位框
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'src')
      token.attrJoin('class', url === null ? 'img-missing' : 'img-loading')
    }
  }
  return renderImage(tokens, index, options, env, self)
}

// 離線時插入、還沒上傳的圖片用 blob: 網址顯示（deviceImages.ts）。DOMPurify 預設會移除 blob:，
// 這裡只放行 App 自己產生的那幾個；筆記裡寫的 blob: 網址（例如 ![](blob:…)）照樣被移除
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.tagName === 'IMG' && data.attrName === 'src' && isDeviceImageUrl(data.attrValue)) data.forceKeepAttr = true
})

// 外部連結在新分頁開啟，並切斷新分頁對本頁的存取（window.opener）
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** 把 Markdown 轉成已過濾、可以安全放進 innerHTML 的 HTML */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const env: RenderEnv = { offline: options.offline, resolveImage: options.resolveImage }
  const html = md.render(source, env)
  return DOMPurify.sanitize(html)
}

/**
 * 找出筆記裡用相對路徑引用的圖片（已解碼、不重複）。用 markdown-it 解析，
 * <…> 包起來的路徑、參考式連結（![x][1]）都跟預覽看到的一樣
 */
export function extractImagePaths(source: string): string[] {
  const paths = new Set<string>()
  const walk = (tokens: ReturnType<typeof md.parse>) => {
    for (const token of tokens) {
      if (token.type === 'image') {
        const src = String(token.attrGet('src') ?? '')
        if (isLocalImagePath(src)) paths.add(decodeImagePath(src))
      }
      if (token.children) walk(token.children)
    }
  }
  walk(md.parse(source, {}))
  return [...paths]
}
