// 垃圾桶：刪除 → 同步 → 列出、還原、永久刪除。兩台裝置用 fake-indexeddb，雲端用記憶體版的假資料表。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDbHandle } from './localDb.ts'
import { RepoError } from './nodes.ts'
import { createLocalRepo } from './repo.local.ts'
import { syncOnce } from './sync.ts'
import { fakeCloud } from './testing/fakeCloud.ts'
import { groupTrash, purgeEntries, restoreEntry, type TrashEntry } from './trash.ts'
import { strings } from '../strings.ts'

const FILE = 'cccccccc-0000-4000-8000-000000000001'

let fake: ReturnType<typeof fakeCloud>
let clock: number
let dbCount = 0

/** 一台裝置；本機的時間每次讀取前進 1 秒（每次刪除的時間都不同） */
function device() {
  const db = createDbHandle(`trash-device-${++dbCount}`)
  const repo = createLocalRepo(db, { now: () => new Date((clock += 1000)) })
  return {
    db,
    repo,
    sync: () => syncOnce(db, fake.cloud),
    /** 這台裝置看到的垃圾桶 */
    trash: async () => groupTrash(await fake.cloud.listTrash(), await repo.listAll()),
    names: async (parentId: string | null = null) => (await repo.listChildren(parentId)).map((node) => node.name),
  }
}

/** 每一筆的重點。一起刪除的列：第一個是最上層，其餘的順序不固定（只保證上層在前），排序後比較 */
const summary = (entries: TrashEntry[]) =>
  entries.map((entry) => ({
    name: entry.node.name,
    rows: [entry.rows[0].name, ...entry.rows.slice(1).map((row) => row.name).sort()],
    path: entry.path,
    parentAlive: entry.parentAlive,
  }))

/**
 * 最上層：課程/（裡面有 筆記、舊筆記、圖/架構圖.webp）、首頁。
 * 先刪「舊筆記」，再刪「課程」（連同裡面），最後刪「首頁」，三次刪除各一筆
 */
async function deleteThreeTimes() {
  const a = device()
  const course = await a.repo.createNode({ parentId: null, type: 'folder', name: '課程' })
  await a.repo.createNode({ parentId: course.id, type: 'note', name: '筆記', content: '內容' })
  const old = await a.repo.createNode({ parentId: course.id, type: 'note', name: '舊筆記', content: '舊的' })
  const images = await a.repo.createNode({ parentId: course.id, type: 'folder', name: '圖' })
  const image = await a.repo.createNode({ parentId: images.id, type: 'image', name: '架構圖.webp', content: FILE })
  const home = await a.repo.createNode({ parentId: null, type: 'note', name: '首頁', content: '' })
  await a.sync()
  await a.repo.deleteNode(old.id)
  await a.repo.deleteNode(course.id)
  await a.repo.deleteNode(home.id)
  await a.sync()
  return { a, course, old, image, home }
}

beforeEach(() => {
  fake = fakeCloud()
  clock = Date.parse('2026-11-27T00:00:00Z')
})

describe('刪除時間', () => {
  it('同一次刪除（資料夾連同裡面的項目）的 deleted_at 一樣，另一次刪除不同', async () => {
    const { course, old, image } = await deleteThreeTimes()
    const deletedAt = (id: string) => fake.rows.get(id)!.deleted_at
    expect(deletedAt(image.id)).toBe(deletedAt(course.id))
    expect(deletedAt(old.id)).not.toBe(deletedAt(course.id))
    expect(Date.parse(deletedAt(old.id)!)).toBeLessThan(Date.parse(deletedAt(course.id)!))
  })
})

describe('groupTrash', () => {
  it('同一次刪除的合成一筆，新刪除的在前；原本的資料夾也刪了時路徑照刪除前的名稱', async () => {
    const { a } = await deleteThreeTimes()
    expect(summary(await a.trash())).toEqual([
      { name: '首頁', rows: ['首頁'], path: '/', parentAlive: true },
      { name: '課程', rows: ['課程', '圖', '架構圖.webp', '筆記'], path: '/', parentAlive: true },
      { name: '舊筆記', rows: ['舊筆記'], path: '/課程/', parentAlive: false },
    ])
    // 還原時上層要先回來
    const names = (await a.trash())[1].rows.map((row) => row.name)
    expect(names.indexOf('圖')).toBeLessThan(names.indexOf('架構圖.webp'))
  })

  it('原本的資料夾還在：parentAlive；永久刪除後的列不列出', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '還在' })
    const note = await a.repo.createNode({ parentId: folder.id, type: 'note', name: '筆記' })
    await a.sync()
    await a.repo.deleteNode(note.id)
    await a.sync()
    const [entry] = await a.trash()
    expect(entry).toMatchObject({ path: '/還在/', parentAlive: true })
    await purgeEntries(fake.cloud, [entry])
    expect(await a.trash()).toEqual([])
  })
})

describe('restoreEntry', () => {
  it('還原資料夾：一起刪除的項目都回來，之前另外刪的（舊筆記）留在垃圾桶', async () => {
    const { a } = await deleteThreeTimes()
    const course = (await a.trash()).find((entry) => entry.node.name === '課程')!
    expect(await restoreEntry(fake.cloud, course, await a.repo.listAll())).toEqual({
      name: '課程',
      parentId: null,
      movedToRoot: false,
    })
    await a.sync()
    const folder = (await a.repo.listChildren(null)).find((node) => node.name === '課程')!
    expect(await a.names(folder.id)).toEqual(['圖', '筆記'])
    expect(summary(await a.trash()).map((entry) => entry.name)).toEqual(['首頁', '舊筆記'])
  })

  it('原本的資料夾還在垃圾桶：放到最上層；資料夾先還原的話放回原處', async () => {
    const { a } = await deleteThreeTimes()
    const old = (await a.trash()).find((entry) => entry.node.name === '舊筆記')!
    expect(await restoreEntry(fake.cloud, old, await a.repo.listAll())).toMatchObject({ parentId: null, movedToRoot: true })
    await a.sync()
    expect(await a.names()).toEqual(['舊筆記'])

    // 另一組：先還原資料夾，再還原舊筆記（一次選好幾筆還原：用的是同一份清單，列出時資料夾還在垃圾桶）
    const b = await deleteThreeTimes()
    const entries = await b.a.trash()
    await restoreEntry(fake.cloud, entries.find((entry) => entry.node.name === '課程')!, await b.a.repo.listAll())
    await b.a.sync()
    const again = entries.find((entry) => entry.node.id === b.old.id)!
    expect(again.parentAlive).toBe(false)
    expect(await restoreEntry(fake.cloud, again, await b.a.repo.listAll())).toMatchObject({ parentId: b.course.id, movedToRoot: false })
    await b.a.sync()
    expect(await b.a.names(b.course.id)).toEqual(['圖', '筆記', '舊筆記'])
  })

  it('撞名加編號：這台裝置看得到的先避開；雲端有、這台還沒同步到的，雲端擋下來再加編號', async () => {
    const { a } = await deleteThreeTimes()
    await a.repo.createNode({ parentId: null, type: 'note', name: '首頁' })
    await a.sync()
    const home = (await a.trash()).find((entry) => entry.node.name === '首頁')!
    expect((await restoreEntry(fake.cloud, home, await a.repo.listAll())).name).toBe('首頁 (2)')

    // 另一台建了「課程」並推送，這台還沒同步
    const b = device()
    await b.sync()
    await b.repo.createNode({ parentId: null, type: 'folder', name: '課程' })
    await b.sync()
    const course = (await a.trash()).find((entry) => entry.node.name === '課程')!
    expect((await restoreEntry(fake.cloud, course, await a.repo.listAll())).name).toBe('課程 (2)')
    await a.sync()
    expect(await a.names()).toEqual(['課程', '課程 (2)', '首頁', '首頁 (2)'])
  })

  it('列出之後被別台還原或改過：說明垃圾桶剛被改過', async () => {
    const { a } = await deleteThreeTimes()
    const home = (await a.trash()).find((entry) => entry.node.name === '首頁')!
    await restoreEntry(fake.cloud, home, await a.repo.listAll()) // 別台先還原了
    const error = await restoreEntry(fake.cloud, home, await a.repo.listAll()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RepoError)
    expect((error as RepoError).message).toBe(strings.trash.changed)
  })
})

describe('purgeEntries', () => {
  it('永久刪除：垃圾桶不再列出、筆記內容清掉；列還在（其他裝置同步得到）', async () => {
    const { a, course } = await deleteThreeTimes()
    const entry = (await a.trash()).find((item) => item.node.name === '課程')!
    expect(await purgeEntries(fake.cloud, [entry])).toBe(4)
    expect(summary(await a.trash()).map((item) => item.name)).toEqual(['首頁', '舊筆記'])
    const note = [...fake.rows.values()].find((row) => row.name === '筆記')!
    expect(note.content).toBeNull()
    expect(fake.rows.get(course.id)?.deleted_at).not.toBeNull()
  })

  it('圖片檔：還有其他項目用到（包含垃圾桶裡的）時保留，都永久刪除了才刪', async () => {
    const a = device()
    const image = await a.repo.createNode({ parentId: null, type: 'image', name: 'a.webp', content: FILE })
    const copy = await a.repo.copyNode(image.id, null)
    await a.sync()
    await a.repo.deleteNode(image.id)
    await a.sync()
    await a.repo.deleteNode(copy.id)
    await a.sync()
    expect(fake.state.removedFiles).toEqual([]) // 刪除時不刪檔案

    const [newer, older] = await a.trash()
    await purgeEntries(fake.cloud, [older])
    expect(fake.state.removedFiles).toEqual([]) // 副本還在垃圾桶，還能還原
    await purgeEntries(fake.cloud, [newer])
    expect(fake.state.removedFiles).toEqual([FILE])
  })

  it('刪圖片檔失敗（例如斷線）不影響永久刪除', async () => {
    const a = device()
    const image = await a.repo.createNode({ parentId: null, type: 'image', name: 'a.webp', content: FILE })
    await a.sync()
    await a.repo.deleteNode(image.id)
    await a.sync()
    fake.cloud.removeImageIfUnused = async () => {
      throw new RepoError('network', '無法連線')
    }
    expect(await purgeEntries(fake.cloud, await a.trash())).toBe(1)
    expect(await a.trash()).toEqual([])
  })

  it('永久刪除後，另一台離線時改過的修改推上來：照「修改優先」還原，之後再刪除會回到垃圾桶', async () => {
    const a = device()
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記', content: '原本' })
    await a.sync()
    const b = device()
    await b.sync()
    await b.repo.updateNode(note.id, { content: 'B 離線時的修改' }) // B 還沒推送

    await a.repo.deleteNode(note.id)
    await a.sync()
    await purgeEntries(fake.cloud, await a.trash())
    await b.sync()
    expect(fake.rows.get(note.id)).toMatchObject({ deleted_at: null, content: 'B 離線時的修改' })
    expect(fake.purged.has(note.id)).toBe(false)

    await b.repo.deleteNode(note.id)
    await b.sync()
    expect(summary(await b.trash()).map((entry) => entry.name)).toEqual(['筆記'])
  })
})
