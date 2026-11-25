// 離線 L1（spec 第 6 節）：連線時照常讀寫 Supabase，同時在這台裝置的 IndexedDB 存一份副本；
// 斷線時改讀副本，只能閱讀。
//
// 副本什麼時候更新：
//   - App 開啟、恢復連線時整批下載（sync）
//   - 在這台裝置新增、修改、移動、刪除成功後，順便寫進副本
//   - 連線時開啟筆記，讀到的最新內容也寫進副本
// 副本屬於哪個帳號記在本機；換帳號時先清掉，登出時整個清除（spec 第 7 節）。

import { RepoError, type TreeNode } from './nodes.ts'
import type { LocalOwner, LocalStore, StillValid } from './repo.local.ts'
import type { Repo } from './repo.ts'

export interface MirrorState {
  /** 已經讀過本機資料庫，知道副本屬於誰 */
  ready: boolean
  /** 本機副本的擁有者；還沒有副本時為 null */
  owner: LocalOwner | null
  /** 目前使用中的帳號；未登入時為 null。本機副本只開放給這個帳號讀 */
  activeUserId: string | null
  /** 正在從雲端整批下載 */
  syncing: boolean
  /** 上一次整批下載失敗的原因 */
  syncError: string | null
}

export interface Mirror {
  /** UI 使用的 repo：連線時讀寫雲端並更新副本，離線時讀副本 */
  repo: Repo
  /** 讀取本機副本的擁有者（App 開啟時呼叫一次） */
  load(): Promise<void>
  /**
   * 開始使用某個帳號。副本屬於別的帳號時先清掉。
   * @param signedIn 是否有有效的登入。沒有登入（離線時登入權杖過期）只能讀副本
   */
  activate(userId: string, email: string, signedIn: boolean): Promise<void>
  /** 從雲端整批下載，取代本機副本。進行中時回傳同一個 Promise */
  sync(): Promise<void>
  /** 登出：清除本機副本，並讓進行中的下載作廢 */
  signOut(): Promise<void>
  getState(): MirrorState
  subscribe(listener: () => void): () => void
}

const NO_COPY_MESSAGE = '離線中，而且這台裝置還沒有離線副本。連線後開啟 App 一次就會自動建立。'

export function createMirror(online: Repo, local: Repo, store: LocalStore, isOnline: () => boolean): Mirror {
  let state: MirrorState = { ready: false, owner: null, activeUserId: null, syncing: false, syncError: null }
  const listeners = new Set<() => void>()

  let signedIn = false
  let activeEmail = ''
  // 登出或換帳號時加 1，讓進行中的下載、寫入作廢
  let generation = 0
  // 進行中的整批下載；touched 記下載期間在這台裝置改過的 id
  let current: { generation: number; touched: Set<string>; promise: Promise<void> } | null = null
  let loading: Promise<void> | null = null
  let activating: Promise<void> = Promise.resolve()

  function setState(patch: Partial<MirrorState>) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /** 這一代（目前的帳號）是否仍有效 */
  function validFor(gen: number): StillValid {
    return () => gen === generation
  }

  function canUseOnline(): boolean {
    return signedIn && isOnline()
  }

  function hasLocalCopy(): boolean {
    return state.activeUserId !== null && state.owner?.userId === state.activeUserId
  }

  function load(): Promise<void> {
    loading ??= store.getOwner().then(
      (owner) => setState({ ready: true, owner }),
      // 這個瀏覽器不能用 IndexedDB（例如封鎖網站資料）：照常線上使用，只是沒有離線副本
      () => setState({ ready: true, owner: null }),
    )
    return loading
  }

  function activate(userId: string, email: string, isSignedIn: boolean): Promise<void> {
    signedIn = isSignedIn
    activeEmail = email
    activating = activating.then(async () => {
      await load()
      if (state.activeUserId === userId) return
      generation++
      current = null
      if (state.owner?.userId !== userId) {
        // 副本屬於別的帳號（或來路不明）：先清掉，避免讀到別人的資料
        setState({ owner: null })
        await store.clear().catch(() => undefined)
      }
      setState({ activeUserId: userId, syncing: false, syncError: null })
    })
    return activating
  }

  function sync(): Promise<void> {
    if (current && current.generation === generation) return current.promise
    const userId = state.activeUserId
    if (!userId || !canUseOnline()) return Promise.resolve()

    const run = { generation, touched: new Set<string>(), promise: Promise.resolve() }
    current = run
    const stillValid = validFor(run.generation)
    setState({ syncing: true, syncError: null })
    run.promise = (async () => {
      try {
        const nodes = await online.listAll()
        const owner: LocalOwner = { userId, email: activeEmail, syncedAt: new Date().toISOString() }
        if (await store.replaceAll(owner, nodes, run.touched, stillValid)) {
          if (stillValid()) setState({ owner })
        }
      } catch (err) {
        if (stillValid()) {
          setState({
            syncError: err instanceof RepoError ? err.message : '無法存到這台裝置（瀏覽器可能封鎖了網站資料或空間不足）。',
          })
        }
      } finally {
        if (current === run) current = null
        if (stillValid()) setState({ syncing: false })
      }
    })()
    return run.promise
  }

  async function signOut(): Promise<void> {
    generation++
    current = null
    signedIn = false
    activating = Promise.resolve()
    setState({ owner: null, activeUserId: null, syncing: false, syncError: null })
    await store.clear()
  }

  // ── 給 UI 用的 repo ─────────────────────────────────────────

  /** 讀取：能連線就讀雲端；離線、或連不到伺服器時改讀副本 */
  async function read<T>(fromOnline: () => Promise<T>, fromLocal: () => Promise<T>, remember?: (value: T) => void): Promise<T> {
    if (canUseOnline()) {
      try {
        const value = await fromOnline()
        remember?.(value)
        return value
      } catch (err) {
        // 只有連線問題才改讀副本；名稱重複、找不到等錯誤照常回報
        if (!(err instanceof RepoError && err.kind === 'network')) throw err
        if (!hasLocalCopy()) throw err
        return fromLocal()
      }
    }
    if (!hasLocalCopy()) throw new RepoError('offline', NO_COPY_MESSAGE)
    return fromLocal()
  }

  /** 雲端寫入成功後更新副本。副本寫入失敗不影響雲端的結果，下次整批下載會補上 */
  function remember(ids: string[], write: (stillValid: StillValid) => Promise<unknown>) {
    if (!state.activeUserId) return
    // 下載進行中：這些 id 以本機的版本為準，不被下載到的舊資料蓋掉
    if (current?.generation === generation) for (const id of ids) current.touched.add(id)
    write(validFor(generation)).catch((err: unknown) => console.warn('更新離線副本失敗', err))
  }

  function rememberRemoval(id: string) {
    remember([id], async (stillValid) => {
      const removed = await store.removeTree(id, stillValid)
      if (current?.generation === generation) for (const nodeId of removed) current.touched.add(nodeId)
    })
  }

  const repo: Repo = {
    listChildren: (parentId) =>
      read(
        () => online.listChildren(parentId),
        () => local.listChildren(parentId),
      ),

    getNode: (id) =>
      read(
        () => online.getNode(id),
        () => local.getNode(id),
        (node: TreeNode | null) => {
          if (node) remember([id], (stillValid) => store.putNode(node, node.content, stillValid))
          else rememberRemoval(id) // 雲端已經沒有（被其他裝置刪除）
        },
      ),

    listAll: () =>
      read(
        () => online.listAll(),
        () => local.listAll(),
      ),

    async createNode(input) {
      if (!canUseOnline()) return local.createNode(input)
      const node = await online.createNode(input)
      const content = node.type === 'note' ? (input.content ?? '') : null
      remember([node.id], (stillValid) => store.putNode(node, content, stillValid))
      return node
    },

    async updateNode(id, patch) {
      if (!canUseOnline()) return local.updateNode(id, patch)
      const node = await online.updateNode(id, patch)
      remember([id], (stillValid) => store.putNode(node, patch.content, stillValid))
      return node
    },

    async moveNode(id, newParentId) {
      if (!canUseOnline()) return local.moveNode(id, newParentId)
      const node = await online.moveNode(id, newParentId)
      remember([id], (stillValid) => store.putNode(node, undefined, stillValid))
      return node
    },

    async deleteNode(id) {
      if (!canUseOnline()) return local.deleteNode(id)
      await online.deleteNode(id)
      rememberRemoval(id)
    },

    // 圖片只存在雲端，離線時一律回絕
    uploadImage: (image) => (canUseOnline() ? online.uploadImage(image) : local.uploadImage(image)),
    getImageUrls: (ids) => (canUseOnline() ? online.getImageUrls(ids) : local.getImageUrls(ids)),
    downloadImage: (id) => (canUseOnline() ? online.downloadImage(id) : local.downloadImage(id)),
  }

  return {
    repo,
    load,
    activate,
    sync,
    signOut,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
