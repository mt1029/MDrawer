// UI 唯一的資料存取介面。UI 只能 import 這個檔案，不直接呼叫 Supabase。
// 核心層 C 直接讀寫 Supabase；離線 L1、L2 時換成讀寫 IndexedDB 的實作，UI 不用改。

import type { NodeMeta, NodeType, TreeNode } from './nodes.ts'
import { onlineRepo } from './repo.online.ts'

export * from './nodes.ts'

export interface CreateNodeInput {
  parentId: string | null
  type: NodeType
  name: string
  content?: string
}

export interface UpdateNodeInput {
  name?: string
  content?: string
}

export interface Repo {
  /** 某個資料夾底下未刪除的項目，資料夾在前、再依名稱排序。parentId 為 null 代表根目錄 */
  listChildren(parentId: string | null): Promise<NodeMeta[]>
  /** 取得單一項目（含筆記內容），找不到或已刪除時回傳 null */
  getNode(id: string): Promise<TreeNode | null>
  createNode(input: CreateNodeInput): Promise<NodeMeta>
  updateNode(id: string, patch: UpdateNodeInput): Promise<NodeMeta>
  /** 移到另一個資料夾，newParentId 為 null 代表移到根目錄。不能移到自己或自己的子孫底下 */
  moveNode(id: string, newParentId: string | null): Promise<NodeMeta>
  /** 標記刪除這個項目，資料夾會連同所有子孫一起標記 */
  deleteNode(id: string): Promise<void>
  /** 上傳一張已壓縮的圖片（WebP 或 JPEG），回傳圖片 id。筆記裡寫成 ![](img:<id>) */
  uploadImage(image: Blob): Promise<string>
  /** 取得圖片的短效網址。找不到或沒有權限的圖片回傳 null */
  getImageUrls(ids: string[]): Promise<Record<string, string | null>>
}

export const repo: Repo = onlineRepo
