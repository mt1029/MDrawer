// 離線 L1：本機副本（IndexedDB）與「連線讀雲端、離線讀副本」的切換。
// 用 fake-indexeddb 模擬瀏覽器的 IndexedDB，雲端用記憶體版的假 repo。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMirror, type Mirror } from './mirror.ts'
import { RepoError, sortNodes, type NodeMeta, type TreeNode } from './nodes.ts'
import { localRepo, localStore } from './repo.local.ts'
import type { Repo } from './repo.ts'

const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

/** 記憶體版的雲端。network 為 true 時每個操作都丟出連線錯誤 */
function fakeCloud() {
  const rows = new Map<string, TreeNode>()
  const cloud = {
    rows,
    network: true,
    /** 設定後 listAll 會等到 release() 才回傳（模擬下載很慢） */
    hold: null as null | { release: () => void; promise: Promise<void> },
  }
  let seq = 0
  const now = () => `2026-11-25T00:00:${String(seq++).padStart(2, '0')}Z`
  const meta = ({ content: _content, ...m }: TreeNode): NodeMeta => m
  const check = () => {
    if (!cloud.network) throw new RepoError('network', '無法連線到伺服器，請確認網路後再試。')
  }
  const live = (id: string) => {
    const row = rows.get(id)
    if (!row) throw new RepoError('not_found', '找不到這個項目。')
    return row
  }
  const touch = (row: TreeNode) => {
    row.version++
    row.updated_at = now()
  }

  const repo: Repo = {
    async listChildren(parentId) {
      check()
      return [...rows.values()].filter((r) => r.parent_id === parentId).map(meta)
    },
    async getNode(id) {
      check()
      const row = rows.get(id)
      return row ? { ...row } : null
    },
    async listAll() {
      check()
      const snapshot = [...rows.values()].map((r) => ({ ...r }))
      if (cloud.hold) await cloud.hold.promise
      return snapshot
    },
    async createNode(input) {
      check()
      const time = now()
      const row: TreeNode = {
        id: crypto.randomUUID(),
        parent_id: input.parentId,
        type: input.type,
        name: input.name,
        content: input.type === 'note' ? (input.content ?? '') : null,
        version: 1,
        created_at: time,
        updated_at: time,
      }
      rows.set(row.id, row)
      return meta(row)
    },
    async updateNode(id, patch) {
      check()
      const row = live(id)
      if (patch.name !== undefined) row.name = patch.name
      if (patch.content !== undefined) row.content = patch.content
      touch(row)
      return meta(row)
    },
    async moveNode(id, newParentId) {
      check()
      const row = live(id)
      row.parent_id = newParentId
      touch(row)
      return meta(row)
    },
    async deleteNode(id) {
      check()
      const queue = [id]
      while (queue.length > 0) {
        const current = queue.shift()!
        rows.delete(current)
        for (const row of rows.values()) if (row.parent_id === current) queue.push(row.id)
      }
    },
    async uploadImage() {
      check()
      return crypto.randomUUID()
    },
    async getImageUrls(ids) {
      check()
      return Object.fromEntries(ids.map((id) => [id, `https://example.test/${id}`]))
    },
    async downloadImage() {
      check()
      return new Blob()
    },
  }

  function add(partial: Partial<TreeNode> & Pick<TreeNode, 'type' | 'name'>): TreeNode {
    const time = now()
    const row: TreeNode = {
      id: crypto.randomUUID(),
      parent_id: null,
      content: partial.type === 'note' ? '' : null,
      version: 1,
      created_at: time,
      updated_at: time,
      ...partial,
    }
    rows.set(row.id, row)
    return row
  }

  function holdListAll() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => (release = resolve))
    cloud.hold = { release, promise }
    return () => {
      cloud.hold = null
      release()
    }
  }

  return { cloud, repo, add, holdListAll }
}

/** 讓背景寫入副本的工作（不等待的 Promise）跑完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

async function expectRepoError(promise: Promise<unknown>, kind: RepoError['kind']) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(RepoError)
  expect((error as RepoError).kind).toBe(kind)
}

let fake: ReturnType<typeof fakeCloud>
let online: boolean
let mirror: Mirror

/** 建立樹：課程/第一週/筆記、最上層的首頁 */
function seed() {
  const course = fake.add({ type: 'folder', name: '課程' })
  const week = fake.add({ type: 'folder', name: '第一週', parent_id: course.id })
  const note = fake.add({ type: 'note', name: '筆記', parent_id: week.id, content: '# 第一週' })
  const home = fake.add({ type: 'note', name: '首頁', content: '歡迎' })
  return { course, week, note, home }
}

beforeEach(async () => {
  await localStore.clear()
  fake = fakeCloud()
  online = true
  mirror = createMirror(fake.repo, localRepo, localStore, () => online)
  await mirror.load()
})

describe('整批下載後，離線可以閱讀全部資料', () => {
  it('離線時改讀副本：資料夾在前、依名稱排序，筆記內容完整', async () => {
    const { course, week, note } = seed()
    fake.add({ type: 'folder', name: 'A 資料夾' })
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    expect(mirror.getState().owner).toMatchObject({ userId: USER_A, email: 'a@example.com' })

    // 排序規則與線上版相同（sortNodes）：資料夾在前，再依名稱
    const expected = sortNodes(await fake.repo.listChildren(null)).map((n) => n.name)
    expect(expected.at(-1)).toBe('首頁')

    online = false
    fake.cloud.network = false
    const root = await mirror.repo.listChildren(null)
    expect(root.map((n) => n.name)).toEqual(expected)
    expect(root.every((n) => !('content' in n) && !('parent_key' in n))).toBe(true)
    expect((await mirror.repo.listChildren(course.id)).map((n) => n.id)).toEqual([week.id])
    expect(await mirror.repo.getNode(note.id)).toEqual(fake.cloud.rows.get(note.id))
    expect(await mirror.repo.listAll()).toHaveLength(5)
  })

  it('再次下載會換成最新的雲端資料（雲端刪掉的也從副本移除）', async () => {
    const { home } = seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    fake.cloud.rows.delete(home.id)
    fake.add({ type: 'note', name: '新筆記' })
    await mirror.sync()

    online = false
    expect((await mirror.repo.listChildren(null)).map((n) => n.name)).toEqual(['課程', '新筆記'])
    expect(await mirror.repo.getNode(home.id)).toBeNull()
  })

  it('下載失敗時保留原本的副本，並記下原因', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    fake.cloud.network = false
    await mirror.sync()
    expect(mirror.getState().syncError).toMatch('無法連線')
    expect(mirror.getState().syncing).toBe(false)

    online = false
    expect(await mirror.repo.listChildren(null)).toHaveLength(2)
  })
})

describe('離線時只能閱讀', () => {
  beforeEach(async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    online = false
  })

  it('新增、修改、移動、刪除與圖片一律回絕，而且沒有送到雲端', async () => {
    const before = JSON.stringify([...fake.cloud.rows.values()])
    const [any] = await mirror.repo.listChildren(null)
    await expectRepoError(mirror.repo.createNode({ parentId: null, type: 'note', name: 'x' }), 'offline')
    await expectRepoError(mirror.repo.updateNode(any.id, { content: 'x' }), 'offline')
    await expectRepoError(mirror.repo.moveNode(any.id, null), 'offline')
    await expectRepoError(mirror.repo.deleteNode(any.id), 'offline')
    await expectRepoError(mirror.repo.uploadImage(new Blob()), 'offline')
    await expectRepoError(mirror.repo.getImageUrls([crypto.randomUUID()]), 'offline')
    await expectRepoError(mirror.repo.downloadImage(crypto.randomUUID()), 'offline')
    expect(JSON.stringify([...fake.cloud.rows.values()])).toBe(before)
  })

  it('離線時不會嘗試整批下載', async () => {
    await mirror.sync()
    expect(mirror.getState().syncing).toBe(false)
    expect(mirror.getState().syncError).toBeNull()
  })
})

describe('連線但連不到伺服器', () => {
  it('讀取改用副本', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    fake.cloud.network = false // 瀏覽器以為有連線，實際上連不到
    expect(await mirror.repo.listChildren(null)).toHaveLength(2)
  })

  it('沒有副本時回報原本的連線錯誤', async () => {
    await mirror.activate(USER_A, 'a@example.com', true)
    fake.cloud.network = false
    await expectRepoError(mirror.repo.listChildren(null), 'network')
  })

  it('不是連線問題的錯誤照常回報，不改讀副本', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    fake.repo.listChildren = () => Promise.reject(new RepoError('unknown', '伺服器錯誤'))
    await expectRepoError(mirror.repo.listChildren(null), 'unknown')
  })

  it('寫入不改用副本，回報連線錯誤', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    fake.cloud.network = false
    await expectRepoError(mirror.repo.createNode({ parentId: null, type: 'note', name: 'x' }), 'network')
  })
})

describe('沒有副本時離線', () => {
  it('讀取回報「還沒有離線副本」', async () => {
    await mirror.activate(USER_A, 'a@example.com', true)
    online = false
    await expectRepoError(mirror.repo.listChildren(null), 'offline')
  })

  it('還沒啟用帳號時不讀副本', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    const other = createMirror(fake.repo, localRepo, localStore, () => false)
    await other.load()
    await expectRepoError(other.repo.listChildren(null), 'offline')
  })
})

describe('連線時的修改同步寫進副本', () => {
  it('新增、改內容、改名、移動、刪除後，離線讀到的是最新的樣子', async () => {
    const { course, week, note, home } = seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()

    const created = await mirror.repo.createNode({ parentId: course.id, type: 'note', name: '新筆記', content: '新內容' })
    await mirror.repo.updateNode(note.id, { content: '# 改過的內容' })
    await mirror.repo.updateNode(home.id, { name: '首頁（改名）' })
    await mirror.repo.moveNode(home.id, course.id)
    await mirror.repo.deleteNode(week.id) // 連同裡面的筆記
    await settle()

    online = false
    expect((await mirror.repo.listChildren(null)).map((n) => n.name)).toEqual(['課程'])
    const inCourse = await mirror.repo.listChildren(course.id)
    expect(inCourse.map((n) => n.name)).toEqual(['首頁（改名）', '新筆記'])
    expect((await mirror.repo.getNode(created.id))?.content).toBe('新內容')
    expect((await mirror.repo.getNode(home.id))?.content).toBe('歡迎') // 改名、移動不影響內容
    expect(await mirror.repo.getNode(week.id)).toBeNull()
    expect(await mirror.repo.getNode(note.id)).toBeNull()
    // 版本號用雲端回傳的，不是自己加
    expect((await mirror.repo.getNode(home.id))?.version).toBe(fake.cloud.rows.get(home.id)?.version)
  })

  it('開啟筆記時把雲端最新的內容寫進副本；雲端已刪除的從副本移除', async () => {
    const { note, home } = seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    fake.cloud.rows.get(note.id)!.content = '別台裝置改的'
    fake.cloud.rows.delete(home.id)
    await mirror.repo.getNode(note.id)
    await mirror.repo.getNode(home.id)
    await settle()

    online = false
    expect((await mirror.repo.getNode(note.id))?.content).toBe('別台裝置改的')
    expect(await mirror.repo.getNode(home.id)).toBeNull()
  })

  it('下載期間的修改不會被下載到的舊資料蓋掉，刪掉的也不會加回來', async () => {
    const { week, note, home } = seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    const release = fake.holdListAll()
    const syncing = mirror.sync() // 先拿到舊資料，等 release 才寫進副本
    await settle()
    expect(mirror.getState().syncing).toBe(true)

    await mirror.repo.updateNode(home.id, { content: '下載期間改的' })
    await mirror.repo.deleteNode(week.id) // 裡面的筆記也一起刪
    await settle()
    release()
    await syncing

    online = false
    expect((await mirror.repo.getNode(home.id))?.content).toBe('下載期間改的')
    expect(await mirror.repo.getNode(week.id)).toBeNull()
    expect(await mirror.repo.getNode(note.id)).toBeNull()
    expect((await mirror.repo.listAll()).map((n) => n.name).sort()).toEqual(['課程', '首頁'])
  })
})

describe('帳號與登出', () => {
  it('換成別的帳號時先清掉前一個帳號的副本', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()

    await mirror.activate(USER_B, 'b@example.com', true)
    expect(mirror.getState().owner).toBeNull()
    expect(await localStore.getOwner()).toBeNull()
    expect(await localRepo.listAll()).toEqual([])
    online = false
    await expectRepoError(mirror.repo.listChildren(null), 'offline')
  })

  it('登出時清除副本（spec 第 7 節）', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()
    await mirror.signOut()

    expect(mirror.getState()).toMatchObject({ owner: null, activeUserId: null })
    expect(await localStore.getOwner()).toBeNull()
    expect(await localRepo.listAll()).toEqual([])
  })

  it('下載途中登出：下載完成後也不會把資料寫回來', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    const release = fake.holdListAll()
    const syncing = mirror.sync()
    await settle()
    await mirror.signOut()
    release()
    await syncing

    expect(await localStore.getOwner()).toBeNull()
    expect(await localRepo.listAll()).toEqual([])
    expect(mirror.getState().syncing).toBe(false)
  })

  it('同一個帳號重新開啟 App 時保留副本', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()

    const reopened = createMirror(fake.repo, localRepo, localStore, () => false)
    await reopened.load()
    expect(reopened.getState().owner?.userId).toBe(USER_A)
    await reopened.activate(USER_A, 'a@example.com', true)
    expect(await reopened.repo.listChildren(null)).toHaveLength(2)
  })

  it('沒有有效登入（離線時權杖過期）：就算連線也只讀副本、不能寫，也不下載', async () => {
    seed()
    await mirror.activate(USER_A, 'a@example.com', true)
    await mirror.sync()

    const reopened = createMirror(fake.repo, localRepo, localStore, () => true)
    await reopened.load()
    await reopened.activate(USER_A, 'a@example.com', false)
    fake.repo.listChildren = () => Promise.reject(new Error('沒有登入時不該讀雲端'))
    expect(await reopened.repo.listChildren(null)).toHaveLength(2)
    await expectRepoError(reopened.repo.createNode({ parentId: null, type: 'note', name: 'x' }), 'offline')
    await reopened.sync()
    expect(reopened.getState().syncing).toBe(false)

    // 換到新的權杖後恢復正常
    await reopened.activate(USER_A, 'a@example.com', true)
    const node = await reopened.repo.createNode({ parentId: null, type: 'note', name: '恢復後新增' })
    expect(fake.cloud.rows.has(node.id)).toBe(true)
  })
})
