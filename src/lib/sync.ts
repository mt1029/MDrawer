// 離線 L2 的同步（spec 第 6 節）：先把待同步佇列推送到雲端，再拉取其他裝置的修改。
// 由 mirror.ts 在連線且已登入時呼叫。斷線等連線錯誤會中止這一輪，佇列保留，下次再試。
//
// 衝突處理（spec 第 6 節）：
//   - 版本吻合：直接成功
//   - 兩端都改同一篇的內容：保留雲端版本，本機版本另存為「名稱（衝突副本 日期時間）」
//   - 改名、移動：以雲端最新版為底，重新套用本機的變更（較晚推送者為準）
//   - 一邊刪除、一邊修改：刪除不會蓋掉修改，項目保留
//   - 同名：自動加「 (2)」重試
//   - 推送成功但回應遺失：重送時發現雲端已經是本機的值，視為成功，不建立衝突副本
//   - 上層資料夾已被其他裝置刪除：放到根目錄

import type { Cloud, CloudRow, RowChanges } from './cloud.ts'
import {
  FIELDS,
  ROOT_KEY,
  addConflictCopy,
  getCursor,
  recordUpdate,
  snapshot,
  toLocal,
  type DbHandle,
  type LocalDb,
  type LocalNode,
  type PendingChange,
  type Snapshot,
  type WriteTx,
} from './localDb.ts'
import { RepoError, numberedName } from './nodes.ts'
import { strings } from '../strings.ts'

// 拉取時往回多抓的時間。資料庫的 updated_at 是交易開始的時間，
// 晚一點 commit 的修改，時間可能比上次看到的還早（ai-log 11/23 的錯誤清單）
export const PULL_OVERLAP_MS = 10_000
// 撞名、版本不符時重試的次數上限
const MAX_ATTEMPTS = 10

export interface SyncReport {
  /** 推送成功的項目數 */
  pushed: number
  /** 因為同步而改變的本機項目（畫面要重新讀取） */
  changed: string[]
  /** 這一輪建立的衝突副本名稱 */
  conflicts: string[]
  /** 推送失敗（斷線以外的原因）的項目，下次同步會再試 */
  failed: { id: string; message: string }[]
  /** 這一輪又產生了要推送的修改（衝突副本、移到根目錄），需要再同步一次 */
  again: boolean
}

export interface SyncOptions {
  now?: () => Date
  /** 登出或換帳號後回傳 false：之後的寫入一律放棄，不把資料寫回已清空的本機資料庫 */
  stillValid?: () => boolean
}

class Cancelled extends Error {}

interface Context {
  db: LocalDb
  cloud: Cloud
  now: () => Date
  stillValid: () => boolean
  report: { pushed: number; changed: Set<string>; conflicts: string[]; failed: SyncReport['failed']; again: boolean }
  /** 雲端上可以放東西的資料夾（存在、未刪除）的查詢結果快取 */
  folders: Map<string, boolean>
}

export async function syncOnce(handle: DbHandle, cloud: Cloud, options: SyncOptions = {}): Promise<SyncReport> {
  const ctx: Context = {
    db: await handle(),
    cloud,
    now: options.now ?? (() => new Date()),
    stillValid: options.stillValid ?? (() => true),
    report: { pushed: 0, changed: new Set(), conflicts: [], failed: [], again: false },
    folders: new Map(),
  }
  try {
    await push(ctx)
    await pull(ctx)
    // 有變動時才檢查樹狀結構（要讀出全部項目）
    if (ctx.report.changed.size > 0) await repairTree(ctx)
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err
  }
  const { report } = ctx
  return { ...report, changed: [...report.changed] }
}

/** 開啟寫入交易。登出或換帳號之後就不再寫入 */
function write(ctx: Context): WriteTx {
  if (!ctx.stillValid()) throw new Cancelled()
  return ctx.db.transaction(['nodes', 'pending'], 'readwrite')
}

function isNetwork(err: unknown): boolean {
  return err instanceof RepoError && err.kind === 'network'
}

// ── 推送 ──────────────────────────────────────────────────────

async function push(ctx: Context) {
  const all = await ctx.db.getAll('pending')
  if (all.length === 0) return

  // 推送順序：
  //   1. 刪除：子項目先、資料夾後（同一次刪除時資料夾的 seq 較小）。反過來的話，其他裝置剛好在中間同步，
  //      會看到「資料夾已刪除、裡面的項目還在」，把它們移到根目錄，被刪的項目就回來了。
  //      刪除放最前面，也讓「刪掉舊的、再建同名的新項目」不會撞名
  //   2. 新增：父先子後（spec 第 6 節推送順序），否則子項目會因為上層還不在雲端而失敗
  //   3. 修改（含改名、移動）：照本機修改的順序。移到新資料夾時，資料夾已經在第 2 步建好
  const deletes = all.filter((c) => c.op === 'delete').sort((a, b) => b.seq - a.seq)
  const creates = all.filter((c) => c.op === 'create')
  if (creates.length > 0) {
    const nodes = new Map((await ctx.db.getAll('nodes')).map((node) => [node.id, node]))
    const depth = (id: string) => {
      let count = 0
      const seen = new Set<string>()
      for (let current = nodes.get(id)?.parent_id; current && !seen.has(current); current = nodes.get(current)?.parent_id) {
        seen.add(current)
        count++
      }
      return count
    }
    creates.sort((a, b) => depth(a.id) - depth(b.id))
  }
  const updates = all.filter((c) => c.op === 'update').sort((a, b) => a.seq - b.seq)

  for (const { id } of [...deletes, ...creates, ...updates]) {
    // 每次重新讀取：前面的項目推送期間，這筆可能又被改過
    const change = await ctx.db.get('pending', id)
    if (!change) continue
    try {
      if (change.op === 'create') await pushCreate(ctx, change)
      else if (change.op === 'update') await pushUpdate(ctx, change)
      else await pushDelete(ctx, change)
      ctx.report.pushed++
    } catch (err) {
      if (err instanceof Cancelled || isNetwork(err)) throw err
      const message = err instanceof RepoError ? err.message : strings.errors.sync.unexpected
      ctx.report.failed.push({ id, message })
      await markFailed(ctx, change, message)
    }
  }
}

/** 雲端上這個 id 是否為可以放東西的資料夾（存在、未刪除） */
async function usableFolder(ctx: Context, id: string): Promise<boolean> {
  const cached = ctx.folders.get(id)
  if (cached !== undefined) return cached
  const [row] = await ctx.cloud.getRows([id])
  const ok = !!row && !row.deleted_at && row.type === 'folder'
  ctx.folders.set(id, ok)
  return ok
}

/** 移動的目標在雲端上是否有效：未刪除的資料夾，而且往上找不到自己（避免兩台裝置交叉移動形成循環） */
async function validMoveTarget(ctx: Context, id: string, targetId: string): Promise<boolean> {
  const visited = new Set<string>()
  for (let current: string | null = targetId, isTarget = true; current; isTarget = false) {
    if (current === id || visited.has(current)) return false
    visited.add(current)
    const [row]: CloudRow[] = await ctx.cloud.getRows([current])
    if (!row || row.deleted_at || (isTarget && row.type !== 'folder')) return false
    current = row.parent_id
  }
  return true
}

async function pushCreate(ctx: Context, change: PendingChange) {
  const node = await ctx.db.get('nodes', change.id)
  if (!node) return dropPending(ctx, change)

  // 上層資料夾已被其他裝置刪除：放到根目錄（spec 第 6 節邊界情況）
  let parentId = node.parent_id
  if (parentId && !(await usableFolder(ctx, parentId))) parentId = null
  let name = node.name

  for (let attempt = 1; ; attempt++) {
    let row: CloudRow | null
    try {
      row = await ctx.cloud.insertIfAbsent({ id: node.id, parent_id: parentId, type: node.type, name, content: node.content })
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !(err instanceof RepoError)) throw err
      if (err.kind === 'duplicate_name') {
        name = numberedName(node.name, attempt + 1) // 同名：加上「 (2)」重試
        continue
      }
      if (err.kind === 'not_found' && parentId) {
        parentId = null // 上層不在雲端（外鍵錯誤）：放到根目錄
        continue
      }
      throw err
    }
    if (row) {
      if (row.type === 'folder') ctx.folders.set(row.id, true)
      return commit(ctx, change, row)
    }
    // id 已經在雲端：之前推送成功但沒收到回應。以雲端那一列為基礎，把不一樣的欄位當成一般修改推送
    const [existing] = await ctx.cloud.getRows([node.id])
    if (!existing) throw new RepoError('unknown', strings.errors.sync.createdMissing)
    const fields = FIELDS.filter((field) => node[field] !== existing[field])
    return pushUpdate(ctx, { ...change, op: 'update', base: snapshot(existing), fields }, existing)
  }
}

/**
 * 推送修改。known 是已經知道的雲端目前的樣子（重送時用），有的話直接以它為底合併。
 */
async function pushUpdate(ctx: Context, change: PendingChange, known?: CloudRow) {
  const node = await ctx.db.get('nodes', change.id)
  if (!node) return dropPending(ctx, change)

  let base: Snapshot = change.base!
  let current = known
  // 沒有要推送的欄位（理論上不會發生）：先讀雲端目前的樣子再判斷
  if (!current && change.fields.length === 0) [current] = await ctx.cloud.getRows([node.id])
  if (!current && change.fields.length === 0) return dropPending(ctx, change)
  let rename: string | undefined // 撞名時改用的名稱
  let toRoot = false // 目標資料夾不能用：放到根目錄
  let copied = false // 已經建立衝突副本

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let changes: RowChanges
    if (current) {
      const merged = merge(node, change, base, current)
      if (merged.contentConflict && !copied) {
        await makeConflictCopy(ctx, node)
        copied = true
      }
      changes = merged.changes
      base = snapshot(current)
    } else {
      changes = pick(node, change.fields)
    }
    if (rename !== undefined) changes.name = rename
    if (toRoot) changes.parent_id = null
    if (changes.parent_id && !(await validMoveTarget(ctx, node.id, changes.parent_id))) {
      changes.parent_id = null
      toRoot = true
    }
    // 雲端已經是本機的樣子（例如之前推送成功但沒收到回應）：不必再送
    if (current && Object.keys(changes).length === 0) return commit(ctx, change, current, copied)

    try {
      const row = await ctx.cloud.updateIfVersion(node.id, changes, base.version)
      if (row) return commit(ctx, change, row, copied)
      // 版本不符：雲端在這段期間被其他裝置改過。讀出目前的樣子，下一圈以它為底重新合併
      ;[current] = await ctx.cloud.getRows([node.id])
      if (!current) return dropPending(ctx, change) // 資料庫不會真的刪列，理論上不會發生
    } catch (err) {
      if (!(err instanceof RepoError)) throw err
      if (err.kind === 'duplicate_name') {
        rename = numberedName(node.name, attempt + 1)
      } else if (err.kind === 'not_found' && changes.parent_id) {
        toRoot = true
      } else {
        throw err
      }
    }
  }
  throw new RepoError('unknown', strings.errors.sync.keepsChanging)
}

/** 以雲端目前的樣子為底，重新套用本機的修改 */
function merge(node: LocalNode, change: PendingChange, base: Snapshot, current: CloudRow) {
  if (current.deleted_at) {
    // 其他裝置刪除了，但這裡有還沒推送的修改：刪除不會蓋掉修改，還原並套用本機的版本
    return {
      changes: { name: node.name, content: node.content, parent_id: node.parent_id, deleted_at: null, purged_at: null } as RowChanges,
      contentConflict: false,
    }
  }
  const changes: RowChanges = {}
  let contentConflict = false
  for (const field of change.fields) {
    // 雲端已經是這個值（包含之前推送成功但沒收到回應的情況）
    if (node[field] === current[field]) continue
    if (field === 'content') {
      // 雲端的內容跟修改前一樣：只有這邊改了內容，直接套用；兩邊都改了：衝突
      if (current.content === base.content) changes.content = node.content
      else contentConflict = true
    } else if (field === 'name') {
      changes.name = node.name
    } else {
      changes.parent_id = node.parent_id
    }
  }
  return { changes, contentConflict }
}

function pick(node: LocalNode, fields: PendingChange['fields']): RowChanges {
  const changes: RowChanges = {}
  for (const field of fields) {
    if (field === 'name') changes.name = node.name
    else if (field === 'content') changes.content = node.content
    else changes.parent_id = node.parent_id
  }
  return changes
}

/** 兩邊都改了同一篇的內容：本機的版本另存為衝突副本（同一個資料夾），原筆記之後換成雲端的版本 */
async function makeConflictCopy(ctx: Context, node: LocalNode) {
  const tx = write(ctx)
  const copy = await addConflictCopy(tx, node.parent_id, node.name, node.content, ctx.now())
  await tx.done
  ctx.report.conflicts.push(copy.name)
  ctx.report.changed.add(copy.id)
  ctx.report.again = true // 副本要在下一輪推送
}

async function pushDelete(ctx: Context, change: PendingChange) {
  // 刪除的項目進垃圾桶：圖片的檔案留著（還原後要顯示），永久刪除時才刪（trash.ts）
  const deletedAt = change.deletedAt ?? ctx.now().toISOString()
  const row = await ctx.cloud.updateIfVersion(change.id, { deleted_at: deletedAt, purged_at: null }, change.base!.version)
  if (row) {
    ctx.folders.set(change.id, false)
    await commit(ctx, change, row)
    return
  }
  const [current] = await ctx.cloud.getRows([change.id])
  // 雲端已經是刪除狀態（另一台也刪了，或之前推送成功但沒收到回應）
  if (!current || current.deleted_at) return dropPending(ctx, change)

  // 雲端在這之後被改過：刪除不會蓋掉較新的修改，保留雲端的版本（spec 第 6 節）
  const tx = write(ctx)
  const latest = await tx.objectStore('pending').get(change.id)
  if (latest?.rev === change.rev) {
    await tx.objectStore('pending').delete(change.id)
    await tx.objectStore('nodes').put(toLocal(current))
  }
  await tx.done
  ctx.report.changed.add(change.id)
}

/**
 * 推送成功後更新本機。推送期間這個項目若又被修改（rev 不同），保留本機的值，
 * 以剛推送的雲端版本作為新的 base，沒推到的部分下次再推。
 * keepCloudContent：內容有衝突、已另存副本，原筆記一律換成雲端的內容。
 */
async function commit(ctx: Context, change: PendingChange, row: CloudRow, keepCloudContent = false) {
  const tx = write(ctx)
  const nodes = tx.objectStore('nodes')
  const pending = tx.objectStore('pending')
  const latest = await pending.get(change.id)
  const local = await nodes.get(change.id)

  if (row.deleted_at) {
    await nodes.delete(change.id)
    if (latest) await pending.delete(change.id)
  } else if (!local) {
    // 推送期間在本機刪掉了：刪除以剛推送的雲端版本為準
    await pending.put({
      id: change.id,
      op: 'delete',
      base: snapshot(row),
      fields: [],
      rev: (latest?.rev ?? change.rev) + 1,
      seq: latest?.seq ?? change.seq,
      deletedAt: latest?.deletedAt,
    })
    ctx.report.again = true
  } else if (!latest || latest.rev === change.rev) {
    await nodes.put(toLocal(row))
    if (latest) await pending.delete(change.id)
  } else {
    const kept: LocalNode = { ...local, version: row.version }
    if (keepCloudContent) kept.content = row.content
    const fields = FIELDS.filter((field) => kept[field] !== row[field])
    if (fields.length === 0) {
      await nodes.put(toLocal(row))
      await pending.delete(change.id)
    } else {
      await nodes.put(kept)
      await pending.put({ ...latest, op: 'update', base: snapshot(row), fields, error: undefined })
    }
  }
  await tx.done
  ctx.report.changed.add(change.id)
}

/** 這筆已經不需要推送：從佇列拿掉（推送期間又被改過的話保留） */
async function dropPending(ctx: Context, change: PendingChange) {
  const tx = write(ctx)
  const latest = await tx.objectStore('pending').get(change.id)
  if (latest?.rev === change.rev) await tx.objectStore('pending').delete(change.id)
  await tx.done
}

async function markFailed(ctx: Context, change: PendingChange, message: string) {
  const tx = write(ctx)
  const latest = await tx.objectStore('pending').get(change.id)
  if (latest) await tx.objectStore('pending').put({ ...latest, error: message })
  await tx.done
}

// ── 拉取 ──────────────────────────────────────────────────────

async function pull(ctx: Context) {
  const cursor = await getCursor(ctx.db)
  // 往回多抓一段，避免漏掉晚 commit 的修改；重複的用 id + version 去掉
  const since = cursor ? new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString() : null
  const rows = await ctx.cloud.pullSince(since)

  if (!ctx.stillValid()) throw new Cancelled()
  const tx = ctx.db.transaction(['nodes', 'pending', 'meta'], 'readwrite')
  const nodes = tx.objectStore('nodes')
  let latest = cursor
  for (const row of rows) {
    if (!latest || Date.parse(row.updated_at) > Date.parse(latest)) latest = row.updated_at
    // 這台還有沒推送的修改：不覆蓋，下次推送時會發現版本不符並處理衝突
    if (await tx.objectStore('pending').get(row.id)) continue
    const local = await nodes.get(row.id)
    if (row.deleted_at) {
      if (local) {
        await nodes.delete(row.id)
        ctx.report.changed.add(row.id)
      }
      continue
    }
    if (local && local.version >= row.version) continue // 已經有這個版本
    await nodes.put(toLocal(row))
    ctx.report.changed.add(row.id)
  }
  // 時間一律用雲端回傳的值，不用本機時鐘（spec 第 6 節）
  if (latest) await tx.objectStore('meta').put(latest, 'cursor')
  await tx.done
}

/**
 * 拉取完成後檢查樹狀結構：上層資料夾已不存在（被其他裝置刪除，而這個項目因為有修改被保留）
 * 或形成循環（兩台裝置交叉移動）的項目，移到根目錄並推送，讓它在畫面上看得到。
 */
async function repairTree(ctx: Context) {
  const tx = write(ctx)
  const nodes = tx.objectStore('nodes')
  const all = await nodes.getAll()
  const parentOf = new Map(all.map((node) => [node.id, node.parent_id]))

  const inCycle = (id: string) => {
    const seen = new Set<string>()
    for (let current = parentOf.get(id) ?? null; current; current = parentOf.get(current) ?? null) {
      if (current === id) return true
      if (seen.has(current)) return false
      seen.add(current)
    }
    return false
  }

  for (const node of all.sort((a, b) => a.id.localeCompare(b.id))) {
    const parent = parentOf.get(node.id)
    if (!parent || (parentOf.has(parent) && !inCycle(node.id))) continue
    await nodes.put({ ...node, parent_id: null, parent_key: ROOT_KEY })
    await recordUpdate(tx, node, ['parent_id'])
    parentOf.set(node.id, null)
    ctx.report.changed.add(node.id)
    ctx.report.again = true
  }
  await tx.done
}
