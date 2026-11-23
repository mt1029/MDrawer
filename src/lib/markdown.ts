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

// 外部連結在新分頁開啟，並切斷新分頁對本頁的存取（window.opener）
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** 把 Markdown 轉成已過濾、可以安全放進 innerHTML 的 HTML */
export function renderMarkdown(source: string): string {
  const html = md.render(source)
  // 之後做貼圖時，img:<uuid> 換成簽名網址的步驟必須放在這裡（DOMPurify 之前），
  // 否則 DOMPurify 會把不認得的 img: 網址移除。見 spec 第 5 節「圖片儲存」。
  return DOMPurify.sanitize(html)
}
