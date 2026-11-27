// UI 唯一的資料存取介面。UI 只能 import 這個檔案，不直接呼叫 Supabase。
// 核心層 C 直接讀寫 Supabase；離線 L2 起改成讀寫這台裝置的 IndexedDB（repo.local.ts），
// 再由 sync.ts 在背景與雲端同步（mirror.ts 負責排程與帳號）。UI 的程式不用改。

import { createDbHandle } from './localDb.ts'
import { createMirror } from './mirror.ts'
import type { NodeMeta, NodeType, TreeNode } from './nodes.ts'
import { cloud, onlineRepo } from './repo.online.ts'
import type { RestoreResult, TrashEntry } from './trash.ts'

export * from './nodes.ts'
export type { LocalOwner } from './localDb.ts'
export type { MirrorState } from './mirror.ts'
export type { RestoreResult, TrashEntry } from './trash.ts'

export interface CreateNodeInput {
  parentId: string | null
  type: NodeType
  name: string
  /** 筆記的內容；圖片是 uploadImage 回傳的圖片檔 id（必填） */
  content?: string
  /** 同一層已有同名的項目時自動加「 (2)」，而不是丟出 duplicate_name（上傳圖片用） */
  rename?: boolean
}

export interface UpdateNodeInput {
  name?: string
  content?: string
  /**
   * 這次的內容是根據哪個版本改的（編輯器載入或上次儲存的內容）。
   * 跟本機目前的內容不同，代表編輯期間被同步改過：不蓋掉，另存為衝突副本（只有本機版使用）
   */
  baseContent?: string
}

export interface Repo {
  /** 某個資料夾底下未刪除的項目，資料夾在前、再依名稱排序。parentId 為 null 代表根目錄 */
  listChildren(parentId: string | null): Promise<NodeMeta[]>
  /** 取得單一項目（含筆記內容），找不到或已刪除時回傳 null */
  getNode(id: string): Promise<TreeNode | null>
  /** 所有未刪除的資料夾、筆記與圖片（含內容），匯出 ZIP、搜尋用 */
  listAll(): Promise<TreeNode[]>
  createNode(input: CreateNodeInput): Promise<NodeMeta>
  updateNode(id: string, patch: UpdateNodeInput): Promise<NodeMeta>
  /** 移到另一個資料夾，newParentId 為 null 代表移到根目錄。不能移到自己或自己的子孫底下 */
  moveNode(id: string, newParentId: string | null): Promise<NodeMeta>
  /** 標記刪除這個項目，資料夾會連同所有子孫一起標記 */
  deleteNode(id: string): Promise<void>
  /**
   * 複製到另一個資料夾，資料夾會連同裡面所有的項目一起複製（都是新的 id）。
   * 目標資料夾裡已經有同名的項目時，名稱加上「 (2)」。不能複製到自己或自己的子孫底下。
   */
  copyNode(id: string, targetParentId: string | null): Promise<NodeMeta>
  /**
   * 上傳一張已壓縮的圖片（WebP 或 JPEG），回傳圖片檔 id；接著用 createNode({ type: 'image', content: id }) 放進資料夾。
   * 離線（或上傳時斷線）時先存在這台裝置，同步時才上傳
   */
  uploadImage(image: Blob): Promise<string>
  /**
   * 取得圖片檔的網址（ids 是圖片檔 id）：雲端的是短效網址，還在這台裝置的是 blob: 網址。
   * 找不到或沒有權限的圖片回傳 null；離線時拿不到的（雲端的圖片）不列出
   */
  getImageUrls(ids: string[]): Promise<Record<string, string | null>>
  /** 下載圖片檔，匯出 ZIP 用（還沒上傳的從這台裝置讀）。Blob 的 type 為 image/webp 或 image/jpeg */
  downloadImage(id: string): Promise<Blob>
  /** 垃圾桶的內容（需要連線）：同一次刪除的項目合成一筆，新刪除的在前 */
  listTrash(): Promise<TrashEntry[]>
  /** 還原垃圾桶的一筆（需要連線）：放回原本的資料夾，已經不在時放到最上層；撞名時加「 (2)」 */
  restoreTrash(entry: TrashEntry): Promise<RestoreResult>
  /** 永久刪除（需要連線；清空垃圾桶時傳入全部），回傳處理了幾個項目 */
  purgeTrash(entries: TrashEntry[]): Promise<number>
}

/** 本機資料與同步：登入後啟用、在背景同步、登出時清除 */
export const mirror = createMirror({ db: createDbHandle(), cloud, online: onlineRepo, isOnline: () => navigator.onLine })

export const repo: Repo = mirror.repo
