// 匯入：用 fake-indexeddb 的本機資料（跟 App 一樣的 repo），壓縮與上傳換成假的。
import 'fake-indexeddb/auto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildZip, planExport } from './exportPlan.ts'
import { ImageError } from './image.ts'
import { ImportError, MAX_IMPORT_FILES, expandZips, readDropped, runImport, type ImportDeps, type ImportSource } from './import.ts'
import { planImport, type ImportFile } from './importPlan.ts'
import { createDbHandle } from './localDb.ts'
import type { TreeNode } from './nodes.ts'
import { createLocalRepo } from './repo.local.ts'
import type { Repo } from './repo.ts'
import { strings } from '../strings.ts'

const file = (path: string, text = '', type = ''): ImportFile => ({ path, file: new Blob([text], { type }) })

let dbCount = 0
function setup() {
  const repo = createLocalRepo(createDbHandle(`import-test-${++dbCount}`))
  const compressed: string[] = []
  const progress: [number, number][] = []
  const deps: ImportDeps = {
    repo: {
      createNode: (input) => repo.createNode(input),
      uploadImage: async () => crypto.randomUUID(),
    },
    // 內容是「壞掉」的圖片壓縮失敗；記下收到的檔案類型
    async compress(blob) {
      compressed.push(blob.type)
      if ((await blob.text()) === '壞掉') throw new ImageError('無法讀取圖片')
      return { blob: new Blob(['webp'], { type: 'image/webp' }), format: 'image/webp' }
    },
    onProgress: (done, total) => progress.push([done, total]),
  }
  return { repo, deps, compressed, progress }
}

/** 所有項目：路徑 → 筆記的內容（資料夾、圖片是類型）。資料夾的路徑以 / 結尾 */
async function tree(repo: Repo): Promise<Record<string, string>> {
  const all = await repo.listAll()
  const byId = new Map(all.map((node) => [node.id, node]))
  const pathOf = (node: TreeNode) => {
    const names: string[] = []
    for (let current: TreeNode | undefined = node; current; current = byId.get(current.parent_id ?? '')) names.unshift(current.name)
    return names.join('/')
  }
  return Object.fromEntries(
    all.map((node) => [pathOf(node) + (node.type === 'folder' ? '/' : ''), node.type === 'note' ? (node.content ?? '') : node.type]),
  )
}

describe('runImport', () => {
  const files = () => [
    file('課程/a.png'),
    file('課程/第一週/筆記.md', '![](../a.png)\r\n![](../a.jpg)'),
    file('課程/a.jpg'),
    file('課程/報告.pdf'),
    file('首頁.md', '![](課程/a.png)'),
  ]

  it('建立資料夾、圖片、筆記；撞名加編號，筆記裡的連結跟著改', async () => {
    const { repo, deps, compressed, progress } = setup()
    await repo.createNode({ parentId: null, type: 'folder', name: '課程' })

    const result = await runImport(planImport(files()), null, deps)

    expect(await tree(repo)).toEqual({
      '課程/': 'folder',
      '課程 (2)/': 'folder',
      '課程 (2)/第一週/': 'folder',
      '課程 (2)/a.webp': 'image',
      '課程 (2)/a (2).webp': 'image',
      // 換行統一成 \n；a.jpg 壓縮後跟 a.png 撞名，變成 a (2).webp
      '課程 (2)/第一週/筆記': '![](../a.webp)\n![](<../a (2).webp>)',
      // 「課程」建立為「課程 (2)」
      首頁: '![](<課程 (2)/a.webp>)',
    })
    expect(result).toMatchObject({ folders: 2, notes: 2, images: 2, skipped: 1, failed: [] })
    expect(result.created.map((node) => node.name)).toEqual(['課程 (2)', '首頁'])
    // ZIP 裡的檔案沒有類型，依副檔名補上
    expect(compressed).toEqual(['image/png', 'image/jpeg'])
    expect(progress.at(-1)).toEqual([6, 6])
  })

  it('放進指定的資料夾', async () => {
    const { repo, deps } = setup()
    const target = await repo.createNode({ parentId: null, type: 'folder', name: '匯入' })
    const result = await runImport(planImport([file('a.md', '內容')]), target.id, deps)
    expect(await tree(repo)).toEqual({ '匯入/': 'folder', '匯入/a': '內容' })
    expect(result.created.map((node) => node.parent_id)).toEqual([target.id])
  })

  it('一張圖片失敗不影響其他的，指到它的連結不改', async () => {
    const { repo, deps } = setup()
    const result = await runImport(
      planImport([file('a.png', '壞掉'), file('b.png'), file('筆記.md', '![](a.png) ![](b.png)')]),
      null,
      deps,
    )
    expect(await tree(repo)).toEqual({ 'b.webp': 'image', 筆記: '![](a.png) ![](b.webp)' })
    expect(result.failed).toEqual([{ name: 'a.png', message: '無法讀取圖片' }])
  })

  it('資料夾建立失敗時，裡面的項目也不建立', async () => {
    const { repo, deps } = setup()
    const broken: ImportDeps = {
      ...deps,
      repo: {
        ...deps.repo,
        createNode: (input) => (input.name === '壞' ? Promise.reject(new Error('寫入失敗')) : repo.createNode(input)),
      },
    }
    const result = await runImport(planImport([file('壞/裡面/a.md'), file('好/b.md')]), null, broken)
    expect(await tree(repo)).toEqual({ '好/': 'folder', '好/b': '' })
    expect(result.failed).toEqual([
      { name: '壞', message: strings.common.unexpectedTryAgain },
      { name: '壞/裡面', message: strings.imports.parentFailed },
      { name: '壞/裡面/a.md', message: strings.imports.parentFailed },
    ])
  })
})

async function zipOf(entries: Record<string, string | null>): Promise<Blob> {
  const zip = new JSZip()
  for (const [path, text] of Object.entries(entries)) {
    if (text === null) zip.folder(path)
    else zip.file(path, text)
  }
  return new Blob([await zip.generateAsync({ type: 'arraybuffer' })])
}

const source = (files: ImportFile[]): ImportSource => ({ files, folders: [], failed: [] })
const sorted = (list: string[]) => [...list].sort()

describe('expandZips', () => {
  it('ZIP 裡有好幾個最上層的項目：放進以 ZIP 檔名命名的資料夾；__MACOSX 忽略、空的資料夾保留', async () => {
    const zip = await zipOf({ 'a.md': '內容', 'b/c.png': 'png', '__MACOSX/._a.md': 'x', 'empty/': null })
    const expanded = await expandZips(source([{ path: '筆記.zip', file: zip }, file('其他.md')]))
    const plan = planImport(expanded.files, expanded.folders)
    expect(sorted(plan.folders.map((folder) => folder.path))).toEqual(['筆記', '筆記/b', '筆記/empty'])
    expect(plan.notes.map((note) => note.path)).toEqual(['筆記/a.md', '其他.md'])
    expect(await plan.notes[0].file.text()).toBe('內容')
    expect(plan.images.map((image) => image.path)).toEqual(['筆記/b/c.png'])
  })

  it('ZIP 裡只有一個最上層的資料夾：就是那個資料夾，不再多包一層', async () => {
    const zip = await zipOf({ '課程/a.md': '', '課程/圖/b.png': '', '__MACOSX/課程/._a.md': 'x' })
    const expanded = await expandZips(source([{ path: '課程.zip', file: zip }]))
    expect(sorted(planImport(expanded.files, expanded.folders).folders.map((folder) => folder.path))).toEqual(['課程', '課程/圖'])
  })

  it('只有一個檔案的 ZIP 也放進資料夾', async () => {
    const expanded = await expandZips(source([{ path: '一篇.zip', file: await zipOf({ 'a.md': '' }) }]))
    expect(planImport(expanded.files, expanded.folders).notes.map((note) => note.path)).toEqual(['一篇/a.md'])
  })

  it('壞掉的 ZIP 記為失敗；資料夾裡的 ZIP 不展開（當成不支援的檔案）', async () => {
    const expanded = await expandZips(source([file('壞掉.zip', '不是 ZIP'), file('資料夾/裡面.zip', '')]))
    expect(expanded.failed).toEqual([{ name: '壞掉.zip', message: strings.imports.badZip }])
    expect(planImport(expanded.files, expanded.folders).skipped).toEqual(['資料夾/裡面.zip'])
  })

  it('檔案太多時整個不匯入', async () => {
    const entries = Object.fromEntries(Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => [`${i}.md`, '']))
    await expect(expandZips(source([{ path: '很多.zip', file: await zipOf(entries) }]))).rejects.toThrow(ImportError)
  })

  it('匯出的 ZIP 匯入回來：結構、筆記內容、圖片都一樣', async () => {
    const IMAGE = 'aaaaaaaa-0000-4000-8000-000000000001'
    const node = (partial: Partial<TreeNode> & Pick<TreeNode, 'id' | 'type' | 'name'>): TreeNode => ({
      parent_id: null,
      content: null,
      version: 1,
      created_at: '2026-11-26T00:00:00Z',
      updated_at: '2026-11-26T00:00:00Z',
      ...partial,
    })
    const exported = planExport(
      [
        node({ id: 'f', type: 'folder', name: '課程' }),
        node({ id: 'i', type: 'image', name: '架構 圖.webp', parent_id: 'f', content: IMAGE }),
        node({ id: 'n', type: 'note', name: '筆記', parent_id: 'f', content: '# 標題\n\n![](<架構 圖.webp>)' }),
        node({ id: 'h', type: 'note', name: '首頁', content: '![](課程/%E6%9E%B6%E6%A7%8B%20%E5%9C%96.webp)' }),
      ],
      () => 'webp',
    )
    const zip = await buildZip(exported, new Map([[IMAGE, new Blob(['webp'], { type: 'image/webp' })]]))

    const { repo, deps } = setup()
    const expanded = await expandZips(source([{ path: 'MDrawer-2026-11-26.zip', file: zip }]))
    const result = await runImport(planImport(expanded.files, expanded.folders), null, deps)
    expect(await tree(repo)).toEqual({
      'MDrawer-2026-11-26/': 'folder',
      'MDrawer-2026-11-26/課程/': 'folder',
      'MDrawer-2026-11-26/課程/架構 圖.webp': 'image',
      'MDrawer-2026-11-26/課程/筆記': '# 標題\n\n![](<架構 圖.webp>)',
      'MDrawer-2026-11-26/首頁': '![](課程/%E6%9E%B6%E6%A7%8B%20%E5%9C%96.webp)',
    })
    expect(result.failed).toEqual([])
  })
})

describe('readDropped', () => {
  // 瀏覽器的 FileSystemEntry：資料夾一次讀兩個（真的瀏覽器是 100 個），要一直讀到空的
  const fileEntry = (fullPath: string, text = '', broken = false) => ({
    isFile: true,
    isDirectory: false,
    name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
    fullPath,
    file: (ok: (file: File) => void, fail: (err: Error) => void) =>
      broken ? fail(new Error('NotReadableError')) : ok(new File([text], fullPath.slice(fullPath.lastIndexOf('/') + 1))),
  })
  const dirEntry = (fullPath: string, children: object[]) => ({
    isFile: false,
    isDirectory: true,
    name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
    fullPath,
    createReader() {
      let next = 0
      return {
        readEntries(ok: (batch: object[]) => void) {
          const batch = children.slice(next, next + 2)
          next += 2
          queueMicrotask(() => ok(batch))
        },
      }
    },
  })

  it('讀出資料夾裡的全部（含空的資料夾），隱藏的資料夾不讀；讀不到的記為失敗', async () => {
    const dropped = await readDropped([
      dirEntry('/課程', [
        fileEntry('/課程/a.md', '內容'),
        dirEntry('/課程/空', []),
        dirEntry('/課程/.git', [fileEntry('/課程/.git/config')]),
        fileEntry('/課程/b.png'),
        fileEntry('/課程/壞.md', '', true),
      ]) as unknown as FileSystemEntry,
      new File(['直接'], 'c.md'),
    ])
    expect(dropped.files.map((item) => item.path)).toEqual(['課程/a.md', '課程/b.png', 'c.md'])
    expect(await dropped.files[0].file.text()).toBe('內容')
    expect(dropped.folders).toEqual(['課程', '課程/空'])
    expect(dropped.failed).toEqual([{ name: '課程/壞.md', message: strings.imports.readFailed }])
  })
})
