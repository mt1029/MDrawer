import { describe, expect, it } from 'vitest'
import {
  imageTypeOf,
  importKind,
  linkSpaces,
  planImport,
  rewriteImageLinks,
  splitImportPath,
  toNodeName,
  type ImportFile,
} from './importPlan.ts'
import { strings } from '../strings.ts'

const file = (path: string, text = ''): ImportFile => ({ path, file: new Blob([text]) })

describe('importKind／imageTypeOf', () => {
  it('.md、.markdown 是筆記，常見的圖片是圖片（不分大小寫），其他略過', () => {
    expect(importKind('筆記.md')).toBe('note')
    expect(importKind('README.MARKDOWN')).toBe('note')
    expect(importKind('照片.PNG')).toBe('image')
    expect(importKind('IMG_0001.heic')).toBe('image')
    expect(importKind('圖.svg')).toBe('other')
    expect(importKind('報告.pdf')).toBe('other')
    expect(importKind('Makefile')).toBe('other')
  })

  it('依副檔名給檔案類型（ZIP 裡的檔案沒有類型）', () => {
    expect(imageTypeOf('a.JPG')).toBe('image/jpeg')
    expect(imageTypeOf('a.webp')).toBe('image/webp')
    expect(imageTypeOf('a.md')).toBeUndefined()
    expect(imageTypeOf('png')).toBeUndefined()
  })
})

describe('splitImportPath', () => {
  it('拆成每一層，去掉空的與 .，Windows 的 \\ 也算分隔', () => {
    expect(splitImportPath('課程/第一週/筆記.md')).toEqual(['課程', '第一週', '筆記.md'])
    expect(splitImportPath('./課程//筆記.md')).toEqual(['課程', '筆記.md'])
    expect(splitImportPath('課程\\筆記.md')).toEqual(['課程', '筆記.md'])
  })

  it('統一 Unicode 組合方式（macOS 的檔名可能是分解的）', () => {
    expect(splitImportPath('café.md')).toEqual(['café.md'])
  })

  it('有 ..、隱藏檔、__MACOSX、系統檔時忽略', () => {
    expect(splitImportPath('../外面.md')).toBeNull()
    expect(splitImportPath('課程/../../外面.md')).toBeNull()
    expect(splitImportPath('__MACOSX/課程/._圖.png')).toBeNull()
    expect(splitImportPath('課程/.DS_Store')).toBeNull()
    expect(splitImportPath('.obsidian/app.json')).toBeNull()
    expect(splitImportPath('課程/Thumbs.db')).toBeNull()
    expect(splitImportPath('')).toBeNull()
  })
})

describe('toNodeName', () => {
  it('換掉不符合名稱規則的字，去掉前後空白，太長就截短', () => {
    expect(toNodeName('a/b\\c')).toBe('a_b_c')
    expect(toNodeName('第一週..備份')).toBe('第一週.備份')
    expect(toNodeName('  筆記  ')).toBe('筆記')
    expect(toNodeName('字'.repeat(120))).toBe('字'.repeat(100))
  })

  it('換完是空的時用「未命名」', () => {
    expect(toNodeName('   ')).toBe(strings.imports.untitled)
  })
})

describe('planImport', () => {
  it('依類型分好，資料夾（含空的）上層在前，筆記去掉副檔名，不支援的列出來，隱藏檔忽略', () => {
    const plan = planImport(
      [
        file('課程/第一週/筆記.md'),
        file('課程/圖.png'),
        file('課程/報告.pdf'),
        file('README.markdown'),
        file('__MACOSX/課程/._圖.png'),
        file('課程/.DS_Store'),
      ],
      ['空資料夾', '課程/第一週/'],
    )
    expect(plan.folders).toEqual([
      { path: '空資料夾', parent: null, name: '空資料夾' },
      { path: '課程', parent: null, name: '課程' },
      { path: '課程/第一週', parent: '課程', name: '第一週' },
    ])
    expect(plan.notes.map(({ path, parent, name }) => ({ path, parent, name }))).toEqual([
      { path: '課程/第一週/筆記.md', parent: '課程/第一週', name: '筆記' },
      { path: 'README.markdown', parent: null, name: 'README' },
    ])
    expect(plan.images.map(({ path, parent, name }) => ({ path, parent, name }))).toEqual([
      { path: '課程/圖.png', parent: '課程', name: '圖.png' },
    ])
    expect(plan.skipped).toEqual(['課程/報告.pdf'])
  })

  it('不支援的檔案所在的資料夾不會建立；名稱不符合規則的資料夾換掉', () => {
    const plan = planImport([file('只有PDF/報告.pdf'), file('a..b/筆記.md')])
    expect(plan.folders.map((folder) => folder.name)).toEqual(['a.b'])
    expect(plan.skipped).toEqual(['只有PDF/報告.pdf'])
  })
})

describe('rewriteImageLinks', () => {
  // 匯入的東西：
  //   課程/（撞名，建立為「課程 (2)」）
  //     a.png（壓縮後變成 a.webp）
  //     same.webp（名稱不變）
  //     壞掉.png（沒有匯入成功）
  //     圖/
  //       b c.jpg（變成 b c.webp）
  const plan = planImport([
    file('課程/a.png'),
    file('課程/same.webp'),
    file('課程/壞掉.png'),
    file('課程/圖/b c.jpg'),
  ])
  const created = new Map([
    ['課程', '課程 (2)'],
    ['課程/圖', '圖'],
    ['課程/a.png', 'a.webp'],
    ['課程/same.webp', 'same.webp'],
    ['課程/圖/b c.jpg', 'b c.webp'],
  ])
  const spaces = linkSpaces(plan, created)
  const rewrite = (content: string, folder: string | null = '課程') => rewriteImageLinks(content, folder, spaces)

  it('改成圖片匯入後的名稱，保留說明與標題', () => {
    expect(rewrite('前面 ![架構](a.png "標題") 後面')).toBe('前面 ![架構](a.webp "標題") 後面')
    expect(rewrite('![](./a.png)')).toBe('![](a.webp)')
    expect(rewrite('![](A.PNG)')).toBe('![](a.webp)')
    expect(rewrite('![說明 [含括號]](a.png)')).toBe('![說明 [含括號]](a.webp)')
  })

  it('有空白的名稱：編碼的、<…> 的都可以，改完用 <…> 包起來', () => {
    expect(rewrite('![](圖/b%20c.jpg)')).toBe('![](<圖/b c.webp>)')
    expect(rewrite('![](<圖/b c.jpg>)')).toBe('![](<圖/b c.webp>)')
  })

  it('從子資料夾往上指、從資料夾外面繞回來、/ 開頭的，都改成相對路徑', () => {
    expect(rewrite('![](../a.png)', '課程/圖')).toBe('![](../a.webp)')
    // 「課程」建立為「課程 (2)」，原本的寫法找不到了
    expect(rewrite('![](../課程/a.png)')).toBe('![](a.webp)')
    expect(rewrite('![](/課程/圖/b%20c.jpg)')).toBe('![](<圖/b c.webp>)')
  })

  it('/ 開頭的：名稱都沒變也改成相對路徑（匯入的位置不一定是最上層）', () => {
    const same = planImport([file('課程/same.webp')])
    const unchanged = linkSpaces(same, new Map([['課程', '課程'], ['課程/same.webp', 'same.webp']]))
    expect(rewriteImageLinks('![](/課程/same.webp)', '課程', unchanged)).toBe('![](same.webp)')
    expect(rewriteImageLinks('![](same.webp)', '課程', unchanged)).toBe('![](same.webp)')
  })

  it('參考式連結的定義也改', () => {
    expect(rewrite('![架構][arch]\n\n[arch]: a.png "標題"')).toBe('![架構][arch]\n\n[arch]: a.webp "標題"')
  })

  it('還找得到的、不是匯入的圖片、網址、沒有匯入成功的、一般連結都不改', () => {
    const untouched = [
      '![](same.webp)',
      '![](%E5%9C%96/b%20c.webp)',
      '![](別的.png)',
      '![](https://example.com/a.png)',
      '![](壞掉.png)',
      '[下載](a.png)',
      '![](../../a.png)',
    ]
    for (const content of untouched) expect(rewrite(content)).toBe(content)
  })

  it('程式碼區塊與行內程式碼裡的不改', () => {
    const content = ['```md', '![](a.png)', '```', '', '`![](a.png)` 與 ![](a.png)', '', '~~~', '![](a.png)', '~~~'].join('\n')
    expect(rewrite(content)).toBe(
      ['```md', '![](a.png)', '```', '', '`![](a.png)` 與 ![](a.webp)', '', '~~~', '![](a.png)', '~~~'].join('\n'),
    )
  })

  it('同一篇有好幾個時全部改，位置不會亂掉', () => {
    expect(rewrite('![](a.png)![](圖/b%20c.jpg)\n![](a.png)')).toBe('![](a.webp)![](<圖/b c.webp>)\n![](a.webp)')
  })
})
