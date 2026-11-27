// 離線時插入的圖片：存在這台裝置（localDb 的 files）→ 同步時先上傳檔案，再推送圖片項目。
// 兩台裝置用 fake-indexeddb，雲端用記憶體版的假資料表與 Storage。
import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import { isDeviceImageUrl } from './deviceImages.ts'
import { MAX_IMAGE_BYTES } from './image.ts'
import { clearAll, createDbHandle } from './localDb.ts'
import { RepoError } from './nodes.ts'
import { createLocalRepo } from './repo.local.ts'
import { UNUSED_FILE_MS, syncOnce } from './sync.ts'
import { fakeCloud } from './testing/fakeCloud.ts'
import { strings } from '../strings.ts'

let fake: ReturnType<typeof fakeCloud>
let clock: number
let dbCount = 0

const webp = (text = 'webp') => new Blob([text], { type: 'image/webp' })

/** 一台裝置；本機與同步用同一個時鐘（測試裡手動往前） */
function device(name = `offline-images-${++dbCount}`) {
  const db = createDbHandle(name)
  const now = () => new Date(clock)
  const repo = createLocalRepo(db, { now })
  return {
    db,
    repo,
    sync: () => syncOnce(db, fake.cloud, { now }),
    /** 這台裝置上還沒上傳的圖片檔 */
    files: async () => ((await (await db()).getAllKeys('files')) as string[]).sort(),
    /** 插入一張圖片（跟編輯器一樣：先存檔，再建立圖片項目） */
    async insert(name: string, parentId: string | null = null, blob = webp()) {
      const fileId = await repo.uploadImage(blob)
      const node = await repo.createNode({ parentId, type: 'image', name, content: fileId, rename: true })
      return { node, fileId }
    },
  }
}

beforeEach(() => {
  fake = fakeCloud()
  clock = Date.parse('2026-11-28T00:00:00Z')
})

describe('存在這台裝置', () => {
  it('同步時先上傳檔案，再推送圖片項目；上傳後本機的檔案刪掉，另一台同步得到', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '課程' })
    await a.sync()
    const { node, fileId } = await a.insert('截圖.webp', folder.id, webp('截圖'))
    expect(await a.files()).toEqual([fileId])

    let uploadedBeforeInsert = false
    fake.state.beforeWrite = async () => {
      uploadedBeforeInsert = fake.files.has(fileId)
    }
    await a.sync()
    expect(uploadedBeforeInsert).toBe(true)
    expect(await fake.files.get(fileId)?.text()).toBe('截圖')
    expect(fake.rows.get(node.id)).toMatchObject({ type: 'image', name: '截圖.webp', content: fileId, parent_id: folder.id })
    expect(await a.files()).toEqual([])

    const b = device()
    await b.sync()
    expect(await b.repo.getNode(node.id)).toMatchObject({ content: fileId, parent_id: folder.id })
  })

  it('還沒上傳的用本機的檔案（blob: 網址、匯出時下載）；其他的不列出', async () => {
    const a = device()
    const fileId = await a.repo.uploadImage(webp('本機'))
    const other = crypto.randomUUID()
    const urls = await a.repo.getImageUrls([fileId, other])
    expect(Object.keys(urls)).toEqual([fileId])
    expect(isDeviceImageUrl(urls[fileId]!)).toBe(true)
    // 同一個檔案只產生一次網址
    expect((await a.repo.getImageUrls([fileId]))[fileId]).toBe(urls[fileId])
    expect(await (await a.repo.downloadImage(fileId)).text()).toBe('本機')
    await expect(a.repo.downloadImage(other)).rejects.toMatchObject({ kind: 'offline' })
  })

  it('不收 Storage 不接受的檔案（格式、超過 2 MB），免得同步時一直失敗', async () => {
    const a = device()
    await expect(a.repo.uploadImage(new Blob(['png'], { type: 'image/png' }))).rejects.toMatchObject({
      message: strings.errors.images.badFormat,
    })
    await expect(a.repo.uploadImage(new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: 'image/webp' }))).rejects.toMatchObject({
      message: strings.errors.images.tooLarge,
    })
    expect(await a.files()).toEqual([])
  })

  it('清除本機資料（登出、換帳號）時一起清掉', async () => {
    const a = device()
    await a.insert('a.webp')
    await clearAll(await a.db())
    expect(await a.files()).toEqual([])
  })
})

describe('上傳失敗', () => {
  it('斷線以外的原因：圖片項目先不推送、記為失敗，其他修改照常推送；之後成功才推送', async () => {
    const a = device()
    await a.sync()
    const { node, fileId } = await a.insert('a.webp')
    const note = await a.repo.createNode({ parentId: null, type: 'note', name: '筆記', content: '![](a.webp)' })
    fake.state.failUploads = true
    const report = await a.sync()
    expect(report.failed).toEqual([{ id: node.id, message: '僅支援 WebP、JPEG 格式的圖片。' }])
    expect(fake.rows.has(node.id)).toBe(false)
    expect(fake.rows.has(note.id)).toBe(true)
    expect(await a.files()).toEqual([fileId])

    fake.state.failUploads = false
    expect((await a.sync()).failed).toEqual([])
    expect(fake.rows.get(node.id)?.content).toBe(fileId)
    expect(await a.files()).toEqual([])
  })

  it('斷線：這一輪中止，什麼都不推送；檔案留著，下次再傳', async () => {
    const a = device()
    await a.sync()
    const { node, fileId } = await a.insert('a.webp')
    fake.state.online = false
    const error = await a.sync().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RepoError)
    expect((error as RepoError).kind).toBe('network')
    expect(await a.files()).toEqual([fileId])
    fake.state.online = true
    await a.sync()
    expect(fake.rows.get(node.id)?.content).toBe(fileId)
  })

  it('上傳成功但回應遺失：重送時檔案已經存在，當成已上傳', async () => {
    const a = device()
    await a.sync()
    const { node, fileId } = await a.insert('a.webp')
    fake.state.dropResponses = 1
    await expect(a.sync()).rejects.toMatchObject({ kind: 'network' })
    expect(fake.rows.has(node.id)).toBe(false)
    await a.sync()
    expect(fake.state.uploads).toEqual([fileId, fileId])
    expect(fake.files.size).toBe(1)
    expect(fake.rows.get(node.id)?.content).toBe(fileId)
  })
})

describe('上傳前的修改', () => {
  it('複製：共用同一個檔案，只上傳一次；改名、移動照常推送', async () => {
    const a = device()
    const folder = await a.repo.createNode({ parentId: null, type: 'folder', name: '圖' })
    const { node, fileId } = await a.insert('a.webp')
    const copy = await a.repo.copyNode(node.id, folder.id)
    await a.repo.updateNode(node.id, { name: 'b.webp' })
    await a.sync()
    expect(fake.state.uploads).toEqual([fileId])
    expect(fake.rows.get(node.id)).toMatchObject({ name: 'b.webp', content: fileId })
    expect(fake.rows.get(copy.id)).toMatchObject({ name: 'a.webp', parent_id: folder.id, content: fileId })
  })

  it('刪除：不上傳，一段時間後才從這台裝置清掉；剛存好、還沒建立項目的（插入途中）不清', async () => {
    const a = device()
    await a.sync()
    const { node, fileId } = await a.insert('a.webp')
    await a.repo.deleteNode(node.id)
    const later = await a.repo.uploadImage(webp('插入途中')) // 檔案存好了，圖片項目還沒建立
    await a.sync()
    expect(fake.state.uploads).toEqual([])
    expect(await a.files()).toEqual([fileId, later].sort())

    const image = await a.repo.createNode({ parentId: null, type: 'image', name: 'b.webp', content: later })
    clock += UNUSED_FILE_MS + 1000
    await a.sync()
    expect(fake.state.uploads).toEqual([later])
    expect(fake.rows.get(image.id)?.content).toBe(later)
    expect(fake.rows.has(node.id)).toBe(false)
    expect(await a.files()).toEqual([])
  })
})

describe('從版本 2 升級', () => {
  it('原本的資料與待同步佇列保留，加上存圖片檔的地方', async () => {
    const name = `offline-images-v2-${++dbCount}`
    const v2 = await openDB(name, 2, {
      upgrade(database) {
        database.createObjectStore('nodes', { keyPath: 'id' }).createIndex('by_parent', 'parent_key')
        database.createObjectStore('meta')
        database.createObjectStore('pending', { keyPath: 'id' })
      },
    })
    const id = crypto.randomUUID()
    const time = '2026-11-27T00:00:00Z'
    await v2.put('nodes', { id, parent_id: null, parent_key: 'root', type: 'note', name: '保留的', content: '', version: 0, created_at: time, updated_at: time })
    await v2.put('pending', { id, op: 'create', base: null, fields: [], rev: 1, seq: 1 })
    v2.close()

    const a = device(name)
    expect((await a.repo.listChildren(null)).map((node) => node.name)).toEqual(['保留的'])
    const { node } = await a.insert('a.webp')
    await a.sync()
    expect(fake.rows.has(id)).toBe(true)
    expect(fake.rows.has(node.id)).toBe(true)
  })
})
