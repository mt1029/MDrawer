// Markdown 解析與 XSS 過濾。畫面上顯示筆記內容一律經過 renderMarkdown。
// 兩道防線：
//   1. markdown-it 設 html: false：筆記裡的 HTML 標籤當成純文字顯示，不會變成真的元素
//   2. DOMPurify：再過濾一次輸出，移除事件屬性、javascript: 等危險網址

import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false, // 不允許原始 HTML（CLAUDE.md 規定）
  linkify: true, // 把純文字網址轉成連結
  typographer: false,
})

/** 筆記裡的圖片寫成 ![](img:<圖片 id>)，id 為小寫 UUID */
export const IMAGE_PREFIX = 'img:'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IMAGE_ID = new RegExp(`^${UUID}$`)
const IMAGE_REF = new RegExp(`${IMAGE_PREFIX}(${UUID})`, 'g')

/**
 * 把圖片 id 換成可顯示的網址。
 * - string：網址
 * - null：圖片不存在或無法取得
 * - undefined：還在取得中
 */
export type ImageResolver = (id: string) => string | null | undefined

// 用 type 而不是 interface，才能當成 markdown-it 的 env（需要索引簽章）
type RenderEnv = {
  resolveImage?: ImageResolver
}

// 在 markdown-it 產生 <img> 時就把 img:<id> 換成網址。
// 這一步一定要在 DOMPurify 之前，否則 DOMPurify 會把不認得的 img: 網址移除（spec 第 5 節）。
// 換上的網址之後仍會經過 DOMPurify，就算網址有問題也會被擋下。
const renderImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const src = String(token.attrGet('src') ?? '')
  if (src.startsWith(IMAGE_PREFIX)) {
    const id = src.slice(IMAGE_PREFIX.length)
    const resolve = (env as RenderEnv | undefined)?.resolveImage
    const url = IMAGE_ID.test(id) ? resolve?.(id) : null
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

// 外部連結在新分頁開啟，並切斷新分頁對本頁的存取（window.opener）
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** 把 Markdown 轉成已過濾、可以安全放進 innerHTML 的 HTML */
export function renderMarkdown(source: string, resolveImage?: ImageResolver): string {
  const env: RenderEnv = { resolveImage }
  const html = md.render(source, env)
  return DOMPurify.sanitize(html)
}

/** 找出筆記裡引用的所有圖片 id（不重複） */
export function extractImageIds(source: string): string[] {
  return [...new Set(Array.from(source.matchAll(IMAGE_REF), (match) => match[1]))]
}

/** 把筆記裡每個 img:<id> 換成 toPath(id) 的結果（匯出 ZIP 時改成相對路徑） */
export function rewriteImageRefs(source: string, toPath: (id: string) => string): string {
  return source.replace(IMAGE_REF, (_match, id: string) => toPath(id))
}
