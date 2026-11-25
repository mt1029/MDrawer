// 離線 L2 的協調者（spec 第 6 節）：
//   - 畫面的讀寫一律在本機完成（repo.local.ts），連線時由 sync.ts 在背景推送與拉取
//   - 同步時機：App 開啟、恢復連線、每 30 秒，以及本機修改後 2 秒（讓另一台裝置早點看到）
//   - 本機資料屬於哪個帳號：換帳號時清除；自己按登出時清除（有未同步的修改由畫面先警告）；
//     被強制登出（例如在別處改了密碼）時若還有未同步的修改，先保留，等同一個帳號重新登入
// 圖片只存在雲端，連線且已登入時才能上傳與顯示。UI 一樣只透過 repo.ts 使用。

import type { Cloud } from './cloud.ts'
import { clearAll, countPending, getOwner, type DbHandle, type LocalOwner } from './localDb.ts'
import { RepoError } from './nodes.ts'
import { createLocalRepo } from './repo.local.ts'
import type { Repo } from './repo.ts'
import { syncOnce } from './sync.ts'

export interface MirrorState {
  /** 已經讀過本機資料庫 */
  ready: boolean
  /** 本機資料屬於哪個帳號；第一次同步完成前為 null */
  owner: LocalOwner | null
  /** 目前使用中的帳號；未登入時為 null */
  activeUserId: string | null
  /** 正在同步 */
  syncing: boolean
  /** 上一次同步失敗的原因 */
  syncError: string | null
  /** 待同步佇列的筆數 */
  pendingCount: number
  /** 這次開啟 App 後建立的衝突副本名稱 */
  conflicts: string[]
  /** 推送失敗（斷線以外的原因）的項目 */
  failures: { id: string; message: string }[]
}

export interface MirrorOptions {
  db: DbHandle
  cloud: Cloud
  /** 圖片用的線上版 repo */
  online: Repo
  isOnline: () => boolean
  /** 定時同步的間隔，0 為不定時同步（測試用） */
  intervalMs?: number
  /** 本機修改後多久同步，0 為不自動同步（測試用） */
  debounceMs?: number
  now?: () => Date
  /** 讓同一個瀏覽器的多個分頁不要同時同步 */
  lock?: <T>(task: () => Promise<T>) => Promise<T>
}

export interface Mirror {
  /** UI 使用的 repo：資料讀寫在本機，圖片連線時讀寫雲端 */
  repo: Repo
  /** 讀取本機資料庫的擁有者與待同步筆數（App 開啟時呼叫一次） */
  load(): Promise<void>
  /**
   * 開始使用某個帳號。本機資料屬於別的帳號時先清掉。
   * @param signedIn 是否有有效的登入。沒有登入（離線時登入權杖過期）照樣可以在本機讀寫，等登入恢復再同步
   */
  activate(userId: string, email: string, signedIn: boolean): Promise<void>
  /** 推送並拉取一次。同步進行中時，結束後會再跑一次 */
  sync(): Promise<void>
  /** 目前待同步的筆數（登出前檢查用） */
  countPending(): Promise<number>
  /** 清除本機資料（自己按登出、或確認丟棄另一個帳號留下的修改）。有未同步的修改要先由畫面確認 */
  signOut(): Promise<void>
  /** 被登出（其他分頁登出、登入被伺服器判定失效）：沒有未同步的修改就清除，有就保留 */
  handleSignedOut(): Promise<void>
  dismissConflicts(): void
  /** 同步改到本機資料時通知（參數為改到的 id），畫面據此重新讀取 */
  onChange(listener: (ids: string[]) => void): () => void
  getState(): MirrorState
  subscribe(listener: () => void): () => void
}

const NO_COPY_MESSAGE = '這台裝置還沒有你的筆記，連線後會自動下載。'
// 一次同步之後，最多再接著跑幾輪（衝突副本、移到根目錄等新產生的修改）
const MAX_ROUNDS = 5

/** 用瀏覽器的 Web Locks 讓多個分頁輪流同步；不支援時直接執行 */
function browserLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks ? locks.request('mdrawer-sync', task) : task()
}

function errorMessage(err: unknown): string {
  if (err instanceof RepoError) {
    return err.kind === 'network' ? '連不到伺服器，修改會在恢復連線後同步。' : err.message
  }
  return '這個瀏覽器無法使用本機儲存（可能封鎖了網站資料或空間不足）。'
}

export function createMirror(options: MirrorOptions): Mirror {
  const { db, cloud, online, isOnline } = options
  const intervalMs = options.intervalMs ?? 30_000
  const debounceMs = options.debounceMs ?? 2_000
  const now = options.now ?? (() => new Date())
  const lock = options.lock ?? browserLock

  let state: MirrorState = {
    ready: false,
    owner: null,
    activeUserId: null,
    syncing: false,
    syncError: null,
    pendingCount: 0,
    conflicts: [],
    failures: [],
  }
  const listeners = new Set<() => void>()
  const changeListeners = new Set<(ids: string[]) => void>()

  let signedIn = false
  let activeEmail = ''
  // 登出或換帳號時加 1，讓進行中的同步作廢
  let generation = 0
  let running: Promise<void> | null = null
  let again = false
  let loading: Promise<void> | null = null
  let activating: Promise<void> = Promise.resolve()
  let interval: ReturnType<typeof setInterval> | undefined
  let soon: ReturnType<typeof setTimeout> | undefined

  function setState(patch: Partial<MirrorState>) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const hasLocalCopy = () => state.activeUserId !== null && state.owner?.userId === state.activeUserId
  const canUseCloud = () => signedIn && isOnline()

  async function refreshPending() {
    try {
      const count = await countPending(await db())
      if (count !== state.pendingCount) setState({ pendingCount: count })
    } catch {
      // 讀不到就維持原本的數字
    }
  }

  function scheduleSoon() {
    if (!debounceMs) return
    clearTimeout(soon)
    soon = setTimeout(() => void sync(), debounceMs)
  }

  function startTimer() {
    if (intervalMs && interval === undefined) interval = setInterval(() => void sync(), intervalMs)
  }

  function stopTimers() {
    clearInterval(interval)
    interval = undefined
    clearTimeout(soon)
  }

  const local = createLocalRepo(db, {
    now,
    onWrite() {
      void refreshPending()
      scheduleSoon()
    },
  })

  /** 記下擁有者。登出或換帳號之後就不寫，避免把資料寫回已清空的本機資料庫 */
  async function saveOwner(owner: LocalOwner, stillValid: () => boolean) {
    const database = await db()
    if (!stillValid()) return
    await database.put('meta', owner, 'owner')
    setState({ owner })
  }

  function load(): Promise<void> {
    loading ??= (async () => {
      try {
        const database = await db()
        const [owner, pendingCount] = await Promise.all([getOwner(database), countPending(database)])
        setState({ ready: true, owner, pendingCount })
      } catch {
        // 不能用 IndexedDB：沒有本機資料，第一次同步時會顯示原因
        setState({ ready: true, owner: null })
      }
    })()
    return loading
  }

  function activate(userId: string, email: string, isSignedIn: boolean): Promise<void> {
    signedIn = isSignedIn
    activeEmail = email
    activating = activating.then(async () => {
      await load()
      const valid = () => true
      if (state.activeUserId !== userId) {
        generation++
        running = null
        if (state.owner?.userId !== userId) {
          // 本機資料屬於別的帳號（或來路不明）：先清掉，避免讀到別人的資料
          setState({ owner: null, pendingCount: 0 })
          await clearAll(await db()).catch(() => undefined)
        }
        setState({ activeUserId: userId, syncing: false, syncError: null, conflicts: [], failures: [] })
        startTimer()
      }
      // 被強制登出後，同一個帳號重新登入：繼續同步保留下來的修改
      if (isSignedIn && state.owner?.signedOut) await saveOwner({ ...state.owner, signedOut: false }, valid)
    })
    return activating
  }

  function sync(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    if (!canUseCloud() || state.activeUserId === null) return Promise.resolve()

    const gen = generation
    const stillValid = () => gen === generation
    const userId = state.activeUserId
    setState({ syncing: true })
    let run: Promise<void> | null = null
    run = (async () => {
      try {
        let rounds = 0
        do {
          again = false
          const report = await lock(() => syncOnce(db, cloud, { now, stillValid }))
          if (!stillValid()) return
          await saveOwner({ userId, email: activeEmail, syncedAt: now().toISOString() }, stillValid)
          setState({
            syncError: null,
            failures: report.failed,
            conflicts: report.conflicts.length > 0 ? [...state.conflicts, ...report.conflicts] : state.conflicts,
          })
          if (report.changed.length > 0) for (const listener of changeListeners) listener(report.changed)
          if (report.again) again = true
        } while (again && ++rounds < MAX_ROUNDS && canUseCloud() && stillValid())
      } catch (err) {
        if (stillValid()) setState({ syncError: errorMessage(err) })
      } finally {
        if (running === run) running = null
        if (stillValid()) {
          setState({ syncing: false })
          await refreshPending()
        }
      }
    })()
    running = run
    return run
  }

  async function signOut(): Promise<void> {
    generation++
    running = null
    signedIn = false
    stopTimers()
    activating = Promise.resolve()
    setState({ owner: null, activeUserId: null, syncing: false, syncError: null, pendingCount: 0, conflicts: [], failures: [] })
    await clearAll(await db())
  }

  async function handleSignedOut(): Promise<void> {
    // 已經清除過（自己按登出時會先清除）
    if (!state.owner && state.activeUserId === null) return
    const pending = await countPending(await db()).catch(() => 0)
    if (pending === 0 || !state.owner) return signOut()
    // 還有未同步的修改：保留資料，等同一個帳號重新登入後同步
    generation++
    running = null
    signedIn = false
    stopTimers()
    activating = Promise.resolve()
    const owner = { ...state.owner, signedOut: true }
    await (await db()).put('meta', owner, 'owner')
    setState({ owner, activeUserId: null, syncing: false, pendingCount: pending })
  }

  /** 資料操作：本機副本要屬於目前的帳號才能讀寫 */
  function guarded<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      if (!hasLocalCopy()) throw new RepoError('offline', NO_COPY_MESSAGE)
      return operation(...args)
    }
  }

  const repo: Repo = {
    listChildren: guarded(local.listChildren),
    getNode: guarded(local.getNode),
    listAll: guarded(local.listAll),
    createNode: guarded(local.createNode),
    updateNode: guarded(local.updateNode),
    moveNode: guarded(local.moveNode),
    deleteNode: guarded(local.deleteNode),
    // 圖片只存在雲端，連線且已登入時才能用
    uploadImage: (image) => (canUseCloud() ? online.uploadImage(image) : local.uploadImage(image)),
    getImageUrls: (ids) => (canUseCloud() ? online.getImageUrls(ids) : local.getImageUrls(ids)),
    downloadImage: (id) => (canUseCloud() ? online.downloadImage(id) : local.downloadImage(id)),
  }

  return {
    repo,
    load,
    activate,
    sync,
    async countPending() {
      return countPending(await db())
    },
    signOut,
    handleSignedOut,
    dismissConflicts: () => setState({ conflicts: [] }),
    onChange(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
