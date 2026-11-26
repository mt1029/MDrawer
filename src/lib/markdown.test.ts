// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { extractImageIds, renderMarkdown, type ImageResolver, type RenderOptions } from './markdown.ts'
import { strings } from '../strings.ts'

/** 把輸出的 HTML 解析成 DOM（不會執行任何 script），方便檢查 */
function render(source: string, resolveImage?: ImageResolver, options?: RenderOptions): HTMLElement {
  const doc = new DOMParser().parseFromString(`<body>${renderMarkdown(source, resolveImage, options)}</body>`, 'text/html')
  return doc.body
}

const DANGEROUS_TAGS = 'script, iframe, object, embed, style, form, svg, math, details, base, meta, link'
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'srcset']

/** 不能有危險標籤、on* 事件屬性、或 javascript: / vbscript: / data:text 網址 */
function expectSafe(body: HTMLElement) {
  expect(body.querySelectorAll(DANGEROUS_TAGS)).toHaveLength(0)
  for (const el of body.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      expect(attr.name, `<${el.tagName.toLowerCase()} ${attr.name}>`).not.toMatch(/^on/i)
      if (URL_ATTRS.includes(attr.name)) {
        // 去掉空白與控制字元後再比對，避免 java\tscript: 這類繞過
        // oxlint-disable-next-line no-control-regex -- 這裡就是要比對控制字元
        const normalized = attr.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase()
        expect(normalized, `${attr.name}="${attr.value}"`).not.toMatch(/^(javascript|vbscript|data:text)/)
      }
    }
  }
}

describe('XSS：spec 第 7 節的三種情況', () => {
  it('<script> 標籤只顯示成文字，不會變成元素', () => {
    const body = render('<script>alert(1)</script>')
    expectSafe(body)
    expect(body.textContent).toContain('<script>alert(1)</script>')
  })

  it('帶 onerror 的圖片只顯示成文字', () => {
    const body = render('<img src=x onerror=alert(1)>')
    expectSafe(body)
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('onerror=alert(1)')
  })

  it('javascript: 連結不會產生可點擊的 href', () => {
    const body = render('[點我](javascript:alert(1))')
    expectSafe(body)
    expect(body.querySelector('a[href]')).toBeNull()
  })
})

describe('XSS：其他常見寫法', () => {
  const payloads: Record<string, string> = {
    '大小寫混合的 javascript:': '[x](JaVaScRiPt:alert(1))',
    'HTML 實體編碼的 javascript:': '[x](&#106;avascript:alert(1))',
    '&colon; 編碼的冒號': '[x](javascript&colon;alert(1))',
    'Tab 插在 javascript 中間': '[x](java\tscript:alert(1))',
    '圖片網址用 javascript:': '![x](javascript:alert(1))',
    '自動連結 <javascript:...>': '<javascript:alert(1)>',
    'vbscript: 連結': '[x](vbscript:msgbox(1))',
    'data:text/html 連結': '[x](data:text/html,<script>alert(1)</script>)',
    '參考式連結指向 javascript:': '[x][1]\n\n[1]: javascript:alert(1)',
    '原始 <a href=javascript:>': '<a href="javascript:alert(1)">x</a>',
    '<svg onload>': '<svg onload=alert(1)>',
    '<iframe>': '<iframe src="javascript:alert(1)"></iframe>',
    '<details ontoggle>': '<details open ontoggle=alert(1)>',
    '<style> 改版面': '<style>body{display:none}</style>',
    '<form action=javascript:>': '<form action="javascript:alert(1)"><button>x</button></form>',
    '連結標題裡塞屬性': '[x](https://example.com " onmouseover=alert(1) x=")',
    '圖片網址裡塞 onerror': '![x](https://example.com/a.png" onerror="alert(1))',
    '表格儲存格裡放 HTML': '| a |\n| - |\n| <img src=x onerror=alert(1)> |',
    '程式碼區塊的語言名稱': '```"><img src=x onerror=alert(1)>\ncode\n```',
  }

  for (const [name, source] of Object.entries(payloads)) {
    it(name, () => expectSafe(render(source)))
  }
})

describe('Markdown 功能：spec 第 3 節要求的語法', () => {
  it('標題', () => {
    const body = render('# 一級\n\n## 二級')
    expect(body.querySelector('h1')?.textContent).toBe('一級')
    expect(body.querySelector('h2')?.textContent).toBe('二級')
  })

  it('清單', () => {
    const body = render('- 甲\n- 乙\n\n1. 一\n2. 二')
    expect(body.querySelectorAll('ul > li')).toHaveLength(2)
    expect(body.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('表格', () => {
    const body = render('| 欄 A | 欄 B |\n| --- | --- |\n| 1 | 2 |')
    expect(body.querySelectorAll('table th')).toHaveLength(2)
    expect(body.querySelectorAll('table td')).toHaveLength(2)
  })

  it('程式碼區塊保留內容、標上語言', () => {
    const body = render('```js\nconst a = "<b>"\n```')
    const code = body.querySelector('pre > code')
    expect(code?.className).toBe('language-js')
    expect(code?.textContent).toBe('const a = "<b>"\n')
  })

  it('圖片', () => {
    const img = render('![說明](https://example.com/a.png)').querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png')
    expect(img?.getAttribute('alt')).toBe('說明')
  })

  it('連結在新分頁開啟，並切斷 window.opener', () => {
    const a = render('[範例](https://example.com)').querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('純文字網址自動變成連結', () => {
    expect(render('看 https://example.com').querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  })
})

describe('貼圖：img:<id> 在 DOMPurify 之前換成網址', () => {
  const ID = '123e4567-e89b-12d3-a456-426614174000'
  const SIGNED = 'https://abc.supabase.co/storage/v1/object/sign/images/u/x?token=t'

  it('換成簽名網址，而且沒有被 DOMPurify 移除', () => {
    const img = render(`![](img:${ID})`, (id) => (id === ID ? SIGNED : undefined)).querySelector('img')
    expect(img?.getAttribute('src')).toBe(SIGNED)
  })

  it('網址還在取得中：沒有 src，標上 img-loading', () => {
    const img = render(`![](img:${ID})`, () => undefined).querySelector('img')
    expect(img?.hasAttribute('src')).toBe(false)
    expect(img?.className).toBe('img-loading')
  })

  it('圖片不存在：沒有 src，標上 img-missing', () => {
    const img = render(`![](img:${ID})`, () => null).querySelector('img')
    expect(img?.hasAttribute('src')).toBe(false)
    expect(img?.className).toBe('img-missing')
  })

  it('id 不是 UUID：不查詢，直接標上 img-missing', () => {
    let asked = false
    const img = render('![](img:../../etc/passwd)', () => {
      asked = true
      return SIGNED
    }).querySelector('img')
    expect(asked).toBe(false)
    expect(img?.hasAttribute('src')).toBe(false)
  })

  it('換上的網址如果是 javascript:，仍會被 DOMPurify 擋下', () => {
    const body = render(`![](img:${ID})`, () => 'javascript:alert(1)')
    expectSafe(body)
  })

  it('離線時還沒有網址的圖片顯示「離線時無法載入圖片」（spec 第 6 節 L1）', () => {
    const body = render(`![說明](img:${ID})`, () => undefined, { offline: true })
    expect(body.querySelector('img')).toBeNull()
    expect(body.querySelector('.img-offline')?.textContent).toBe(strings.markdown.offlineImage)
  })

  it('離線時已經有網址的圖片照常顯示，不存在的仍標上 img-missing', () => {
    const shown = render(`![](img:${ID})`, () => SIGNED, { offline: true }).querySelector('img')
    expect(shown?.getAttribute('src')).toBe(SIGNED)
    const missing = render(`![](img:${ID})`, () => null, { offline: true }).querySelector('img')
    expect(missing?.className).toBe('img-missing')
  })

  it('離線佔位框不會帶出圖片說明裡的 HTML', () => {
    const body = render(`![<img src=x onerror=alert(1)>](img:${ID})`, () => undefined, { offline: true })
    expectSafe(body)
    expect(body.querySelectorAll('img')).toHaveLength(0)
  })

  it('找出筆記裡的圖片 id，去掉重複並忽略格式不對的', () => {
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const source = `![](img:${ID})\n![說明](img:${other})\n![](img:${ID})\n![](img:not-a-uuid)`
    expect(extractImageIds(source)).toEqual([ID, other])
  })
})
