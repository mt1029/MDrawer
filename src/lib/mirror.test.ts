// 離線 L2 的帳號、登出與排程（mirror.ts）。雲端用最簡單的記憶體版。
import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Cloud, CloudRow } from './cloud.ts'
import { createDbHandle, type DbHandle } from './localDb.ts'
import { createMirror, type Mirror } from './mirror.ts'
import { RepoError } from './nodes.ts'
import type { Repo } from './repo.ts'

const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

let rows: Map<string, CloudRow>
let online: boolean
let holdPull: Promise<void> | null
let clock: number

const cloud: Cloud = {
  async pullSince(since) {
    if (!online) throw new RepoError('network', '無法連線')
    const result = [...rows.values()].filter((r) => !since || Date.parse(r.updated_at) >= Date.parse(since)).map((r) => ({ ...r }))
    if (holdPull) await holdPull
    return result
  },
  async getRows(ids) {
    return ids.flatMap((id) => (rows.has(id) ? [{ ...rows.get(id)! }] : []))
  },
  async insertIfAbsent(row) {
    if (!online) throw new RepoError('network', '無法連線')
    if (rows.has(row.id)) return null
    const time = new Date((clock += 1000)).toISOString()
    const created = { ...row, version: 1, created_at: time, updated_at: time, deleted_at: null }
    rows.set(row.id, created)
    return { ...created }
  },
  async updateIfVersion(id, changes, version) {
    if (!online) throw new RepoError('network', '無法連線')
    const row = rows.get(id)
    if (!row || row.version !== version) return null
    const next = { ...row, ...changes, version: row.version + 1, updated_at: new Date((clock += 1000)).toISOString() }
    rows.set(id, next)
    return { ...next }
  },
  async removeImageIfUnused() {
    return false
  },
  async listTrash() {
    if (!online) throw new RepoError('network', '無法連線')
    return [...rows.values()].filter((r) => r.deleted_at).map(({ content: _content, ...r }) => r)
  },
  async purge() {
    return []
  },
}

// 圖片用的線上版 repo：只記錄有沒有被呼叫
let imageCalls = 0
const onlineImages = {
  uploadImage: async () => {
    imageCalls++
    return crypto.randomUUID()
  },
  getImageUrls: async () => {
    imageCalls++
    return {}
  },
  downloadImage: async () => {
    imageCalls++
    return new Blob()
  },
} as unknown as Repo

let dbCount = 0
let db: DbHandle
let mirror: Mirror

function makeMirror(handle: DbHandle = db) {
  return createMirror({ db: handle, cloud, online: onlineImages, isOnline: () => online, intervalMs: 0, debounceMs: 0, lock: (task) => task() })
}

async function stores(handle: DbHandle = db) {
  const database = await handle()
  return {
    nodes: await database.getAll('nodes'),
    pending: await database.getAll('pending'),
    meta: await database.getAllKeys('meta'),
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

/** 帳號 A 登入並完成第一次同步 */
async function signInA(m: Mirror = mirror) {
  await m.load()
  await m.activate(USER_A, 'a@example.com', true)
  await m.sync()
}

beforeEach(() => {
  rows = new Map()
  online = true
  holdPull = null
  clock = Date.parse('2026-11-25T00:00:00Z')
  imageCalls = 0
  db = createDbHandle(`test-mirror-${++dbCount}`)
  mirror = makeMirror()
})

describe('第一次同步', () => {
  it('完成前不能讀寫（避免畫面看到空的或別人的資料）；完成後記下擁有者', async () => {
    await mirror.load()
    await mirror.activate(USER_A, 'a@example.com', true)
    await expectRepoError(mirror.repo.listChildren(null), 'offline')
    await mirror.sync()
    expect(mirror.getState().owner).toMatchObject({ userId: USER_A, email: 'a@example.com' })
    expect(await mirror.repo.listChildren(null)).toEqual([])
  })

  it('離線時寫入本機，恢復連線後同步；修改後通知畫面待同步的筆數', async () => {
    await signInA()
    online = false
    await mirror.repo.createNode({ parentId: null, type: 'note', name: '離線寫的' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mirror.getState().pendingCount).toBe(1)
    await mirror.sync() // 離線時不會嘗試
    expect(rows.size).toBe(0)
    online = true
    await mirror.sync()
    expect(rows.size).toBe(1)
    expect(mirror.getState().pendingCount).toBe(0)
  })

  it('同步改到本機資料時通知畫面（其他裝置新增的項目）', async () => {
    await signInA()
    const changed: string[][] = []
    mirror.onChange((ids) => changed.push(ids))
    const id = crypto.randomUUID()
    rows.set(id, { id, parent_id: null, type: 'note', name: '別台新增的', content: '', version: 1, created_at: '2026-11-25T01:00:00Z', updated_at: '2026-11-25T01:00:00Z', deleted_at: null })
    await mirror.sync()
    expect(changed).toEqual([[id]])
  })

  it('圖片只在連線且已登入時使用雲端', async () => {
    await signInA()
    await mirror.repo.getImageUrls([crypto.randomUUID()])
    expect(imageCalls).toBe(1)
    online = false
    await expectRepoError(mirror.repo.uploadImage(new Blob()), 'offline')
    expect(imageCalls).toBe(1)
  })
})

describe('帳號與登出（spec 第 6、7 節）', () => {
  it('換成別的帳號時，先清掉前一個帳號的資料', async () => {
    await signInA()
    await mirror.repo.createNode({ parentId: null, type: 'note', name: 'A 的筆記' })
    await mirror.activate(USER_B, 'b@example.com', true)
    expect(await stores()).toEqual({ nodes: [], pending: [], meta: [] })
    await expectRepoError(mirror.repo.listChildren(null), 'offline')
  })

  it('自己按登出：清空本機資料與佇列', async () => {
    await signInA()
    online = false
    await mirror.repo.createNode({ parentId: null, type: 'note', name: '沒同步的' })
    expect(await mirror.countPending()).toBe(1) // 畫面據此先警告
    await mirror.signOut()
    expect(await stores()).toEqual({ nodes: [], pending: [], meta: [] })
    expect(mirror.getState()).toMatchObject({ owner: null, activeUserId: null, pendingCount: 0 })
  })

  it('被強制登出、沒有未同步的修改：清除', async () => {
    await signInA()
    await mirror.handleSignedOut()
    expect(await stores()).toEqual({ nodes: [], pending: [], meta: [] })
  })

  it('被強制登出、還有未同步的修改：保留並標記；同一個帳號重新登入後推送', async () => {
    await signInA()
    online = false
    const note = await mirror.repo.createNode({ parentId: null, type: 'note', name: '離線寫的' })
    await mirror.handleSignedOut()
    expect(mirror.getState().owner).toMatchObject({ userId: USER_A, signedOut: true })
    expect(mirror.getState().activeUserId).toBeNull()
    expect((await stores()).pending).toHaveLength(1)

    // 重新開啟 App 也記得
    const reopened = makeMirror()
    await reopened.load()
    expect(reopened.getState()).toMatchObject({ owner: { signedOut: true }, pendingCount: 1 })

    online = true
    await reopened.activate(USER_A, 'a@example.com', true)
    expect(reopened.getState().owner?.signedOut).toBe(false)
    await reopened.sync()
    expect(rows.get(note.id)?.name).toBe('離線寫的')
  })

  it('被強制登出後改用別的帳號：前一個帳號留下的修改被清除', async () => {
    await signInA()
    online = false
    await mirror.repo.createNode({ parentId: null, type: 'note', name: '離線寫的' })
    await mirror.handleSignedOut()
    online = true
    await mirror.signOut() // 畫面確認「刪除這些修改並繼續」
    await mirror.activate(USER_B, 'b@example.com', true)
    await mirror.sync()
    expect((await stores()).pending).toEqual([])
    expect(await mirror.repo.listAll()).toEqual([])
  })

  it('沒有有效登入（離線時權杖過期）：照樣在本機讀寫，不推送；登入恢復後推送', async () => {
    await signInA()
    const reopened = makeMirror()
    await reopened.load()
    await reopened.activate(USER_A, 'a@example.com', false)
    const note = await reopened.repo.createNode({ parentId: null, type: 'note', name: '權杖過期時寫的' })
    await reopened.sync()
    expect(rows.has(note.id)).toBe(false)
    await reopened.activate(USER_A, 'a@example.com', true)
    await reopened.sync()
    expect(rows.has(note.id)).toBe(true)
  })

  it('同步途中登出：下載到的資料不會寫回已清空的本機資料庫', async () => {
    await signInA()
    const id = crypto.randomUUID()
    rows.set(id, { id, parent_id: null, type: 'note', name: '下載中', content: '', version: 1, created_at: '2026-11-25T01:00:00Z', updated_at: '2026-11-25T01:00:00Z', deleted_at: null })
    let release!: () => void
    holdPull = new Promise((resolve) => (release = resolve))
    const syncing = mirror.sync()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await mirror.signOut()
    release()
    await syncing
    expect(await stores()).toEqual({ nodes: [], pending: [], meta: [] })
  })
})

describe('從 L1 升級', () => {
  it('L1（資料庫版本 1）的副本保留，加上待同步佇列；第一次同步補上雲端已刪除的項目', async () => {
    const name = `test-mirror-v1-${++dbCount}`
    const kept = crypto.randomUUID()
    const removed = crypto.randomUUID()
    const row = (id: string, title: string) => ({
      id,
      parent_id: null,
      type: 'note' as const,
      name: title,
      content: '',
      version: 1,
      created_at: '2026-11-25T00:00:00Z',
      updated_at: '2026-11-25T00:00:00Z',
    })
    const v1 = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('nodes', { keyPath: 'id' }).createIndex('by_parent', 'parent_key')
        database.createObjectStore('meta')
      },
    })
    await v1.put('nodes', { ...row(kept, '保留的'), parent_key: 'root' })
    await v1.put('nodes', { ...row(removed, '雲端已刪除的'), parent_key: 'root' })
    await v1.put('meta', { userId: USER_A, email: 'a@example.com', syncedAt: '2026-11-25T00:00:00Z' }, 'owner')
    v1.close()
    rows.set(kept, { ...row(kept, '保留的'), deleted_at: null })
    rows.set(removed, { ...row(removed, '雲端已刪除的'), version: 2, deleted_at: '2026-11-25T00:30:00Z' })

    const upgraded = makeMirror(createDbHandle(name))
    await upgraded.load()
    await upgraded.activate(USER_A, 'a@example.com', true)
    expect((await upgraded.repo.listChildren(null)).map((n) => n.name)).toEqual(['保留的', '雲端已刪除的'])
    expect(await upgraded.countPending()).toBe(0)
    await upgraded.sync()
    expect((await upgraded.repo.listChildren(null)).map((n) => n.name)).toEqual(['保留的'])
  })
})
