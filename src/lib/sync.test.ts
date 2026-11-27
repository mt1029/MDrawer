// 離線 L2：本機寫入、推送、拉取與衝突處理（spec 第 6 節）。
// 用 fake-indexeddb 模擬兩台裝置各自的 IndexedDB，雲端用記憶體版的假資料表（規則比照資料庫：
// version 由「資料庫」加 1、同層未刪除的名稱不分大小寫不可重複、上層必須存在）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CloudRow } from './cloud.ts'
import { createDbHandle } from './localDb.ts'
import { RepoError } from './nodes.ts'
import { createLocalRepo } from './repo.local.ts'
import { syncOnce } from './sync.ts'
import { fakeCloud } from './testing/fakeCloud.ts'
import { strings } from '../strings.ts'

/** 衝突副本的名稱：原名稱接 strings 裡的後綴，時間是「年-月-日 時:分」。改了文案測試也跟著改 */
function conflictCopyPattern(name: string): RegExp {
  const marker = '\u0000'
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const [before, after] = strings.errors.names.conflictCopySuffix(marker).split(marker)
  return new RegExp(`^${escape(name + before)}\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}${escape(after)}$`)
}


let fake: ReturnType<typeof fakeCloud>
let dbCount = 0

/** 一台裝置：自己的 IndexedDB、本機 repo，與雲端同步 */
function device() {
  const db = createDbHandle(`test-device-${++dbCount}`)
  const repo = createLocalRepo(db)
  return {
    db,
    repo,
    sync: () => syncOnce(db, fake.cloud),
    pending: async () => (await db()).getAll('pending'),
    names: async (parentId: string | null = null) => (await repo.listChildren(parentId)).map((n) => n.name),
    content: async (id: string) => (await repo.getNode(id))?.content,
  }
}

async function expectRepoError(promise: Promise<unknown>, kind: RepoError['kind']) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(RepoError)
  expect((error as RepoError).kind).toBe(kind)
}

beforeEach(() => {
  fake = fakeCloud()
})

describe('本機寫入：離線也能新增、修改、移動、刪除', () => {
  it('寫進本機與待同步佇列；version 為 0（只由資料庫寫入）', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '課程' })
    const note = await a.repo.createNode({ parentId: folder.id, type: 'note', name: '筆記', content: '內容' })
    expect(note.version).toBe(0)
    expect(await a.names(folder.id)).toEqual(['筆記'])
    expect((await a.pending()).map((c) => c.op)).toEqual(['create', 'create'])
    expect(fake.rows.size).toBe(0) // 還沒推送
  })

  it('本機也檢查名稱規則：同層不分大小寫不可同名、不能移到自己底下、不能有 ..', async () => {
    const a = device()
    const outer = await a.repo.createNode({ parentId: null, type: 'folder', name: 'Notes' })
    const inner = await a.repo.createNode({ parentId: outer.id, type: 'folder', name: '子資料夾' })
    await expectRepoError(a.repo.createNode({ parentId: null, type: 'note', name: 'notes' }), 'duplicate_name')
    await expectRepoError(a.repo.updateNode(inner.id, { name: '../x' }), 'invalid_name')
    await expectRepoError(a.repo.moveNode(outer.id, inner.id), 'invalid_move')
    await expectRepoError(a.repo.moveNode(outer.id, outer.id), 'invalid_move')
    // 檢查失敗的操作不會留下任何修改
    expect(await a.pending()).toHaveLength(2)
  })

  it('刪除資料夾連同子孫；還沒推送過的新項目直接拿掉，不進佇列', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '資料夾' })
    await a.repo.createNode({ parentId: folder.id, type: 'note', name: '筆記' })
    await a.repo.deleteNode(folder.id)
    expect(await a.repo.listAll()).toEqual([])
    expect(await a.pending()).toEqual([])
  })
})

describe('資料夾裡的圖片', () => {
  const FILE = 'bbbbbbbb-0000-4000-8000-000000000001'
  const FILE2 = 'bbbbbbbb-0000-4000-8000-000000000002'

  it('圖片是一個項目，content 是圖片檔的 id；推送到雲端的列也是', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '課程' })
    const image = await a.repo.createNode({ parentId: folder.id, type: 'image', name: '架構圖.webp', content: FILE })
    expect(image.type).toBe('image')
    expect(await a.content(image.id)).toBe(FILE)
    await a.sync()
    expect(fake.rows.get(image.id)).toMatchObject({ type: 'image', name: '架構圖.webp', content: FILE, parent_id: folder.id })
  })

  it('圖片的 content 一定要是圖片檔的 id', async () => {
    const a = device()
    await expectRepoError(a.repo.createNode({ parentId: null, type: 'image', name: 'a.webp' }), 'unknown')
    await expectRepoError(a.repo.createNode({ parentId: null, type: 'image', name: 'a.webp', content: 'not-an-id' }), 'unknown')
    expect(await a.names()).toEqual([])
  })

  it('rename：撞名時自動加編號，圖片的編號在副檔名前面', async () => {
    const a = device()
    await a.repo.createNode({ parentId: null, type: 'image', name: '照片.webp', content: FILE })
    const second = await a.repo.createNode({ parentId: null, type: 'image', name: '照片.WEBP', content: FILE2, rename: true })
    expect(second.name).toBe('照片 (2).WEBP')
    // 沒有 rename 時照樣丟出撞名
    await expectRepoError(a.repo.createNode({ parentId: null, type: 'image', name: '照片.webp', content: FILE2 }), 'duplicate_name')
  })

  it('複製圖片：新的項目、共用同一個圖片檔（離線也能複製）', async () => {
    const a = device()
    const image = await a.repo.createNode({ parentId: null, type: 'image', name: 'a.webp', content: FILE })
    const copy = await a.repo.copyNode(image.id, null)
    expect(copy).toMatchObject({ type: 'image', name: 'a (2).webp' })
    expect(await a.content(copy.id)).toBe(FILE)
  })

  it('刪除圖片：推送後只標記刪除，圖片檔留著（在垃圾桶還能還原；永久刪除時才刪，見 trash.test.ts）', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '資料夾' })
    const image = await a.repo.createNode({ parentId: folder.id, type: 'image', name: 'a.webp', content: FILE })
    const copy = await a.repo.copyNode(image.id, null)
    await a.sync()
    await a.repo.deleteNode(folder.id)
    await a.repo.deleteNode(copy.id)
    await a.sync()
    expect(fake.rows.get(image.id)?.deleted_at).not.toBeNull()
    expect(fake.rows.get(copy.id)?.deleted_at).not.toBeNull()
    expect(fake.state.removedFiles).toEqual([])
  })
})

describe('複製（剪下、複製、貼上）', () => {
  it('複製筆記到同一個資料夾：名稱加上「 (2)」，內容相同，是新的項目', async () => {
    const a = device()
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記', content: '內容 ![](圖.webp)' })
    const copy = await a.repo.copyNode(note.id, null)
    expect(copy.id).not.toBe(note.id)
    expect(copy).toMatchObject({ name: '筆記 (2)', version: 0, parent_id: null })
    expect(await a.content(copy.id)).toBe(await a.content(note.id))
    const again = await a.repo.copyNode(note.id, null)
    expect(again.name).toBe('筆記 (3)')
  })

  it('複製資料夾連同所有子孫；同步後雲端有完整的副本（父先子後）', async () => {
    const a = device()
    const b = device()
    const course = await a.repo.createNode({ parentId: null, type: 'folder', name: '課程' })
    const week = await a.repo.createNode({ parentId: course.id, type: 'folder', name: '第一週' })
    await a.repo.createNode({ parentId: week.id, type: 'note', name: '筆記', content: '第一週的內容' })
    const archive = await a.repo.createNode({ parentId: null, type: 'folder', name: '封存' })
    await a.sync()

    const copy = await a.repo.copyNode(course.id, archive.id)
    expect(copy).toMatchObject({ name: '課程', parent_id: archive.id })
    const [copiedWeek] = await a.repo.listChildren(copy.id)
    expect(copiedWeek.name).toBe('第一週')
    expect(copiedWeek.id).not.toBe(week.id)
    const [copiedNote] = await a.repo.listChildren(copiedWeek.id)
    expect(await a.content(copiedNote.id)).toBe('第一週的內容')
    expect(await a.repo.listChildren(course.id)).toHaveLength(1) // 原本的沒有變

    const report = await a.sync()
    expect(report.failed).toEqual([])
    expect(fake.rows.get(copiedNote.id)).toMatchObject({ parent_id: copiedWeek.id, content: '第一週的內容' })
    await b.sync()
    expect(await b.names(archive.id)).toEqual(['課程'])
  })

  it('不能把資料夾複製到自己或自己底下', async () => {
    const a = device()
    const outer = await a.repo.createNode({ parentId: null, type: 'folder', name: '外層' })
    const inner = await a.repo.createNode({ parentId: outer.id, type: 'folder', name: '內層' })
    await expectRepoError(a.repo.copyNode(outer.id, inner.id), 'invalid_move')
    await expectRepoError(a.repo.copyNode(outer.id, outer.id), 'invalid_move')
    await expectRepoError(a.repo.copyNode(outer.id, crypto.randomUUID()), 'not_found')
    expect((await a.repo.listAll()).map((n) => n.name).sort()).toEqual(['內層', '外層'])
  })
})

describe('推送', () => {
  it('離線建立的多層資料夾：父先子後推送（先建的資料夾移進後建的也可以）', async () => {
    const a = device()
    const first = await a.repo.createNode({ parentId: null, type: 'folder', name: '先建的' })
    const second = await a.repo.createNode({ parentId: null, type: 'folder', name: '後建的' })
    await a.repo.moveNode(first.id, second.id)
    const note = await a.repo.createNode({ parentId: first.id, type: 'note', name: '筆記', content: '內容' })

    const report = await a.sync()
    expect(report.failed).toEqual([])
    expect(fake.rows.get(second.id)?.parent_id).toBeNull()
    expect(fake.rows.get(first.id)?.parent_id).toBe(second.id)
    expect(fake.rows.get(note.id)).toMatchObject({ parent_id: first.id, content: '內容', version: 1 })
    expect(await a.pending()).toEqual([])
    // 本機換成資料庫寫入的 version 與時間
    expect((await a.repo.getNode(note.id))?.updated_at).toBe(fake.rows.get(note.id)?.updated_at)
  })

  it('修改、改名、移動、刪除推送後，另一台同步就看得到', async () => {
    const a = device()
    const b = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '資料夾' })
    const note = await a.repo.createNode({ parentId: folder.id, type: 'note', name: '筆記', content: 'v1' })
    const loose = await a.repo.createNode({ parentId: null, type: 'note', name: '散落的' })
    const trash = await a.repo.createNode({ parentId: null, type: 'folder', name: '要刪的' })
    await a.sync()
    await b.sync()
    expect(await b.names()).toEqual(expect.arrayContaining(['資料夾', '要刪的', '散落的']))

    await a.repo.updateNode(note.id, { content: 'v2' })
    await a.repo.updateNode(loose.id, { name: '改名後' })
    await a.repo.moveNode(loose.id, folder.id)
    await a.repo.deleteNode(trash.id)
    await a.sync()
    await b.sync()

    expect(await b.content(note.id)).toBe('v2')
    expect(await b.names(folder.id)).toEqual(expect.arrayContaining(['筆記', '改名後']))
    expect(await b.repo.getNode(trash.id)).toBeNull()
    expect(fake.rows.get(trash.id)?.deleted_at).not.toBeNull()
  })

  it('推送期間又修改：新的修改不會被清掉，下一輪推送', async () => {
    const a = device()
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記' })
    await a.sync()
    await a.repo.updateNode(note.id, { content: '第一次' })
    fake.state.beforeWrite = async () => {
      await a.repo.updateNode(note.id, { content: '第二次' })
    }
    await a.sync()
    expect(fake.rows.get(note.id)?.content).toBe('第一次')
    expect(await a.content(note.id)).toBe('第二次')
    expect(await a.pending()).toHaveLength(1)

    await a.sync()
    expect(fake.rows.get(note.id)?.content).toBe('第二次')
    expect(await a.pending()).toEqual([])
  })

  it('斷線：這一輪中止、佇列保留，恢復後完成', async () => {
    const a = device()
    await a.repo.createNode({ parentId: null, type: 'note', name: '筆記' })
    fake.state.online = false
    await expectRepoError(a.sync(), 'network')
    expect(await a.pending()).toHaveLength(1)
    fake.state.online = true
    await a.sync()
    expect(await a.pending()).toEqual([])
    expect(fake.rows.size).toBe(1)
  })

  it('推送成功但回應遺失：重送時視為成功，不重複新增、不建立衝突副本（spec 第 6 節邊界情況）', async () => {
    const a = device()
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記', content: 'v1' })
    fake.state.dropResponses = 1
    await expectRepoError(a.sync(), 'network')
    expect(fake.rows.size).toBe(1) // 雲端其實已經新增了
    await a.sync()
    expect(fake.rows.size).toBe(1)
    expect(await a.pending()).toEqual([])

    await a.repo.updateNode(note.id, { content: 'v2' })
    fake.state.dropResponses = 1
    await expectRepoError(a.sync(), 'network')
    const report = await a.sync()
    expect(report.conflicts).toEqual([])
    expect(fake.rows.size).toBe(1)
    expect(fake.rows.get(note.id)).toMatchObject({ content: 'v2', version: 2 })
    expect(await a.pending()).toEqual([])
  })

  it('同名：另一台剛好建了同名的項目，自動加上「 (2)」，本機也跟著改名', async () => {
    const a = device()
    const b = device()
    await a.repo.createNode({ parentId: null, type: 'note', name: 'README' })
    const mine = await b.repo.createNode({ parentId: null, type: 'note', name: 'readme' })
    await a.sync()
    await b.sync()
    expect(fake.rows.get(mine.id)?.name).toBe('readme (2)')
    expect((await b.repo.getNode(mine.id))?.name).toBe('readme (2)')
  })

  it('刪掉舊的再建同名的新項目：刪除先推送，不會變成「 (2)」', async () => {
    const a = device()
    const old = await a.repo.createNode({ parentId: null, type: 'note', name: '週報' })
    await a.sync()
    await a.repo.deleteNode(old.id)
    const fresh = await a.repo.createNode({ parentId: null, type: 'note', name: '週報' })
    await a.sync()
    expect(fake.rows.get(fresh.id)?.name).toBe('週報')
  })

  it('刪除資料夾時子項目先推送：其他裝置不會看到「資料夾已刪除、裡面的還在」', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '資料夾' })
    const note = await a.repo.createNode({ parentId: folder.id, type: 'note', name: '筆記' })
    await a.sync()
    await a.repo.deleteNode(folder.id)
    const order: string[] = []
    const update = fake.cloud.updateIfVersion
    fake.cloud.updateIfVersion = (id, changes, version) => {
      order.push(id)
      return update(id, changes, version)
    }
    await a.sync()
    expect(order).toEqual([note.id, folder.id])
  })
})

describe('衝突處理（spec 第 6 節）', () => {
  /** 兩台裝置都有「資料夾/筆記」 */
  async function twoDevices() {
    const a = device()
    const b = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '資料夾' })
    const note = await a.repo.createNode({ parentId: folder.id, type: 'note', name: '筆記', content: '原本' })
    await a.sync()
    await b.sync()
    return { a, b, folder, note }
  }

  it('兩端都改同一篇的內容：雲端保留先推送的，後推送的另存為衝突副本（同一個資料夾）', async () => {
    const { a, b, folder, note } = await twoDevices()
    await a.repo.updateNode(note.id, { content: 'A 的版本' })
    await b.repo.updateNode(note.id, { content: 'B 的版本' })
    await a.sync()
    const report = await b.sync()

    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatch(conflictCopyPattern('筆記'))
    expect(report.again).toBe(true)
    expect(fake.rows.get(note.id)?.content).toBe('A 的版本')
    expect(await b.content(note.id)).toBe('A 的版本') // 原筆記換成雲端版本

    await b.sync() // 副本在下一輪推送
    const copy = fake.live(report.conflicts[0])
    expect(copy).toMatchObject({ parent_id: folder.id, content: 'B 的版本' })
    await a.sync()
    expect(await a.names(folder.id)).toEqual(expect.arrayContaining(['筆記', report.conflicts[0]]))
  })

  it('一邊改名、一邊改內容：兩個修改都保留', async () => {
    const { a, b, note } = await twoDevices()
    await a.repo.updateNode(note.id, { name: '新名稱' })
    await b.repo.updateNode(note.id, { content: 'B 改的內容' })
    await a.sync()
    const report = await b.sync()
    expect(report.conflicts).toEqual([])
    expect(fake.rows.get(note.id)).toMatchObject({ name: '新名稱', content: 'B 改的內容' })
    expect(await b.repo.getNode(note.id)).toMatchObject({ name: '新名稱', content: 'B 改的內容' })
  })

  it('兩邊都改名：較晚推送的為準', async () => {
    const { a, b, note } = await twoDevices()
    await a.repo.updateNode(note.id, { name: 'A 取的名' })
    await b.repo.updateNode(note.id, { name: 'B 取的名' })
    await a.sync()
    await b.sync()
    expect(fake.rows.get(note.id)?.name).toBe('B 取的名')
  })

  it('一邊刪除、一邊修改，修改先推送：刪除不生效，刪除的那台拿回項目', async () => {
    const { a, b, note } = await twoDevices()
    await a.repo.deleteNode(note.id)
    await b.repo.updateNode(note.id, { content: 'B 的修改' })
    await b.sync()
    await a.sync()
    expect(fake.rows.get(note.id)).toMatchObject({ deleted_at: null, content: 'B 的修改' })
    expect(await a.content(note.id)).toBe('B 的修改')
  })

  it('一邊刪除、一邊修改，刪除先推送：修改的那台推送時還原項目', async () => {
    const { a, b, note } = await twoDevices()
    await a.repo.deleteNode(note.id)
    await b.repo.updateNode(note.id, { content: 'B 的修改' })
    await a.sync()
    expect(fake.rows.get(note.id)?.deleted_at).not.toBeNull()
    await b.sync()
    expect(fake.rows.get(note.id)).toMatchObject({ deleted_at: null, content: 'B 的修改' })
    await a.sync()
    expect(await a.content(note.id)).toBe('B 的修改')
  })

  it('本機新建項目的上層已被另一台刪除：放到根目錄（spec 第 6 節邊界情況）', async () => {
    const { a, b, folder } = await twoDevices()
    const mine = await b.repo.createNode({ parentId: folder.id, type: 'note', name: '離線新增的' })
    await a.repo.deleteNode(folder.id)
    await a.sync()
    await b.sync()
    expect(fake.rows.get(mine.id)?.parent_id).toBeNull()
    expect(await b.names()).toContain('離線新增的')
    expect(await b.repo.getNode(folder.id)).toBeNull()
  })

  it('兩台交叉移動資料夾（會形成循環）：後推送的移動改成放在根目錄', async () => {
    const a = device()
    const b = device()
    const p = await a.repo.createNode({ parentId: null, type: 'folder', name: 'P' })
    const q = await a.repo.createNode({ parentId: null, type: 'folder', name: 'Q' })
    await a.sync()
    await b.sync()
    await a.repo.moveNode(p.id, q.id)
    await b.repo.moveNode(q.id, p.id)
    await a.sync()
    await b.sync()
    expect(fake.rows.get(p.id)?.parent_id).toBe(q.id)
    expect(fake.rows.get(q.id)?.parent_id).toBeNull()
    expect(await b.names()).toEqual(['Q'])
  })

  it('編輯器載入後這篇被同步改過：不蓋掉，這次的內容另存為衝突副本', async () => {
    const { a, b, folder, note } = await twoDevices()
    await b.repo.updateNode(note.id, { content: 'B 改的' })
    await b.sync()
    await a.sync() // 拉到 B 的修改，但 A 的編輯器還停在「原本」
    await expectRepoError(a.repo.updateNode(note.id, { content: 'A 打的字', baseContent: '原本' }), 'conflict')
    expect(await a.content(note.id)).toBe('B 改的')
    const copies = (await a.repo.listChildren(folder.id)).filter((n) => conflictCopyPattern(note.name).test(n.name))
    expect(copies).toHaveLength(1)
    expect(await a.content(copies[0].id)).toBe('A 打的字')
  })
})

describe('拉取', () => {
  it('其他裝置的新增、修改、刪除都會進來；這台還沒推送的修改不被覆蓋', async () => {
    const a = device()
    const b = device()
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記', content: '原本' })
    const gone = await a.repo.createNode({ parentId: null, type: 'note', name: '會被刪的' })
    await a.sync()
    await b.sync()

    await b.repo.updateNode(note.id, { content: 'B 還沒推送的' })
    await a.repo.updateNode(note.id, { name: 'A 改的名' })
    await a.repo.deleteNode(gone.id)
    const added = await a.repo.createNode({ parentId: null, type: 'note', name: 'A 新增的' })
    await a.sync()

    fake.state.failUpdates = true // B 這一輪推送失敗，但拉取照常
    const report = await b.sync()
    expect(report.failed.map((f) => f.id)).toEqual([note.id])
    expect((await b.pending())[0].error).toMatch('測試用的失敗')
    expect(await b.repo.getNode(note.id)).toMatchObject({ name: '筆記', content: 'B 還沒推送的' })
    expect(await b.repo.getNode(gone.id)).toBeNull()
    expect(await b.repo.getNode(added.id)).not.toBeNull()

    fake.state.failUpdates = false
    await b.sync()
    expect(fake.rows.get(note.id)).toMatchObject({ name: 'A 改的名', content: 'B 還沒推送的' })
    expect(await b.repo.getNode(note.id)).toMatchObject({ name: 'A 改的名', content: 'B 還沒推送的' })
  })

  it('晚 commit 的修改（時間比上次看到的早幾秒）也拉得到；重複拉到的不會重寫', async () => {
    const a = device()
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記' })
    await a.sync()
    const cursor = fake.rows.get(note.id)!.updated_at
    const late: CloudRow = {
      id: crypto.randomUUID(),
      parent_id: null,
      type: 'note',
      name: '晚 commit 的',
      content: '',
      version: 1,
      created_at: cursor,
      updated_at: new Date(Date.parse(cursor) - 5000).toISOString(),
      deleted_at: null,
    }
    fake.rows.set(late.id, late)
    const report = await a.sync()
    expect(report.changed).toEqual([late.id]) // 往回多抓到的「筆記」版本相同，不算變動
    expect(await a.repo.getNode(late.id)).not.toBeNull()
  })

  it('資料夾被另一台刪除、裡面有這台沒看過的項目：移到根目錄並推送', async () => {
    const a = device()
    const b = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '資料夾' })
    await a.sync()
    await b.sync()
    const fromB = await b.repo.createNode({ parentId: folder.id, type: 'note', name: 'B 新增的' })
    await b.sync()
    await a.repo.deleteNode(folder.id) // A 還沒拉到 B 新增的筆記，只刪了資料夾
    const report = await a.sync()
    expect(report.again).toBe(true)
    expect(await a.names()).toEqual(['B 新增的'])
    await a.sync()
    expect(fake.rows.get(fromB.id)).toMatchObject({ parent_id: null, deleted_at: null })
    await b.sync()
    expect(await b.names()).toEqual(['B 新增的'])
  })
})
