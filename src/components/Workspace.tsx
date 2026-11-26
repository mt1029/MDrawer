import {
  IconChevronLeft,
  IconClipboard,
  IconCopy,
  IconCut,
  IconFileImport,
  IconFilePlus,
  IconFiles,
  IconFolderPlus,
  IconFolderUp,
  IconLayoutNavbarCollapse,
  IconLayoutNavbarExpand,
  IconPencil,
  IconPhotoUp,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { NODE_DRAG_TYPE } from '../lib/dnd.ts'
import { formatTime } from '../lib/format.ts'
import { ImageError, compressImage, keepOrCompress } from '../lib/image.ts'
import { ImportError, entriesFromDrop, expandZips, filesFromInput, readDropped, runImport, type ImportSource } from '../lib/import.ts'
import { planImport } from '../lib/importPlan.ts'
import {
  RepoError,
  folderPath,
  imageFileName,
  mirror,
  repo,
  sortNodes,
  type NodeMeta,
  type NodeType,
} from '../lib/repo.ts'
import type { LineHit, SearchResult } from '../lib/search.ts'
import { rangeBetween, topLevelOnly, visibleOrder } from '../lib/selection.ts'
import { useContextMenuTrigger } from '../lib/useContextMenuTrigger.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { useMirror } from '../lib/useMirror.ts'
import ConfirmDialog from './ConfirmDialog.tsx'
import ContextMenu, { type MenuItems, type MenuRequest } from './ContextMenu.tsx'
import FileTree, { type TreeDrag } from './FileTree.tsx'
import ImageViewer from './ImageViewer.tsx'
import { Icon, IconButton } from './icons.tsx'
import NameDialog from './NameDialog.tsx'
import NoteEditor, { type Reveal } from './NoteEditor.tsx'
import SearchPanel from './SearchPanel.tsx'
import { strings } from '../strings.ts'

const ROOT = 'root'
const keyOf = (parentId: string | null) => parentId ?? ROOT

type DialogState =
  | { kind: 'create'; type: NodeType; parentId: string | null }
  | { kind: 'rename'; node: NodeMeta }
  | { kind: 'delete'; nodes: NodeMeta[] }

/** 側欄的面板：檔案總管或搜尋 */
type Panel = 'explorer' | 'search'

/** 剪下或複製、還沒貼上的項目（App 自己的剪貼簿，不影響系統剪貼簿） */
type Clipboard = { mode: 'cut' | 'copy'; nodes: NodeMeta[] }

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
/** 快捷鍵的顯示文字：Mac 為 ⌘X，其他為 Ctrl+X */
const shortcut = (key: string) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`)
/** 打開搜尋的快捷鍵（跟 VS Code 一樣） */
const SEARCH_SHORTCUT = IS_MAC ? '⇧⌘F' : 'Ctrl+Shift+F'
const isCopyDrag = (event: DragEvent) => (IS_MAC ? event.altKey : event.ctrlKey)
// 只有滑鼠能拖曳；觸控裝置長按是開選單，用剪下、貼上移動
const CAN_DRAG = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
// 拖曳時游標停在收合的資料夾上多久就展開（毫秒）
const DRAG_EXPAND_MS = 700
// 小螢幕（spec 第 3 節介面改版第 4 步）：側欄與編輯器各佔一整個畫面
const NARROW = '(max-width: 720px)'
// 進入編輯器時在瀏覽器歷史記錄加一筆，Android 的返回手勢、Safari 的往回滑都會回到清單
const DETAIL_STATE = 'mdrawer-detail'

const TYPE_LABEL: Record<NodeType, string> = strings.workspace.types
/** 同步狀態：等待同步的筆數、最後同步時間、失敗原因、衝突副本 */
function SyncStatus() {
  const { owner, syncing, syncError, pendingCount, failures, conflicts } = useMirror()
  let status: string
  const text = strings.workspace.sync
  if (pendingCount > 0) status = syncing ? text.pendingSyncing(pendingCount) : text.pending(pendingCount)
  else if (syncing) status = text.syncing
  else status = owner ? text.synced(formatTime(owner.syncedAt)) : ''

  return (
    <>
      {status && <p className="status-line">{status}</p>}
      {syncError && !syncing && (
        <p className="status-line warning">
          {text.failed(syncError)}{' '}
          <button type="button" className="link-button" onClick={() => void mirror.sync()}>
            {strings.common.retry}
          </button>
        </p>
      )}
      {failures.length > 0 && (
        <p className="status-line warning">
          {text.cannotSync(failures.length, failures[0].message)}
        </p>
      )}
      {conflicts.length > 0 && (
        <p className="status-line warning" role="status">
          {text.conflicts(conflicts.length, conflicts)}{' '}
          <button type="button" className="link-button" onClick={() => mirror.dismissConflicts()}>
            {strings.common.gotIt}
          </button>
        </p>
      )}
    </>
  )
}

interface Props {
  /** 可以連到雲端（連線且已登入）：才能插入、顯示圖片 */
  cloud: boolean
}

/**
 * 登入後的主畫面，版面類似程式編輯器（spec 第 3 節介面改版第 2 步）：
 * 最左側的圖示欄切換面板，側欄是檔案總管（標題列的圖示游標移到側欄才顯示），右側顯示選取的項目。
 * 改名、移動、刪除在右鍵選單（觸控長按、鍵盤選單鍵或 Shift+F10）。
 */
export default function Workspace({ cloud }: Props) {
  // 每個資料夾已載入的子項目，key 為資料夾 id，根目錄為 ROOT
  const [childrenOf, setChildrenOf] = useState<Record<string, NodeMeta[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // 目前打開的項目（右側顯示的那一個）與選取的項目（可以多選）。跟 VS Code 一樣，⌘／Ctrl、Shift 點選只改變選取，
  // 右側仍顯示原本打開的項目（所以可以多選好幾張圖片拖進打開的筆記）。Shift 點選從 anchor 選到點的那一個
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 上傳圖片、匯入的進度與結果（側欄上方）。完成的訊息幾秒後自動消失；sticky 的（例如有略過的檔案）按「OK」才消失
  const [notice, setNotice] = useState<{ text: string; busy: boolean; sticky?: boolean } | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const importTarget = useRef<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panel, setPanel] = useState<Panel>('explorer')
  // 搜尋框的內容放在這裡：切到檔案總管再切回來還在
  const [searchQuery, setSearchQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  // 資料改變（讀取資料夾、儲存筆記）時遞增，搜尋結果跟著更新
  const [dataVersion, setDataVersion] = useState(0)
  // 從搜尋結果打開時，編輯器要捲到、選取的位置
  const [reveal, setReveal] = useState<(Reveal & { noteId: string }) | null>(null)
  const revealCount = useRef(0)
  const [menu, setMenu] = useState<(MenuRequest & { targetId: string | null }) | null>(null)
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)
  // 拖曳中的項目，以及要放進去的位置（資料夾 id；null 為最上層；undefined 為沒有）
  const [dragging, setDragging] = useState<NodeMeta[] | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined)
  const expandTimer = useRef<{ id: string; timer: number } | null>(null)
  // 小螢幕：目前在編輯器畫面（否則在清單畫面）。回到清單時恢復原本的捲動位置
  const narrow = useMediaQuery(NARROW)
  const [inDetail, setInDetail] = useState(false)
  const listScroll = useRef(0)
  const backButton = useRef<HTMLButtonElement>(null)

  const loadChildren = useCallback(async (parentId: string | null) => {
    const list = await repo.listChildren(parentId)
    setChildrenOf((prev) => ({ ...prev, [keyOf(parentId)]: list }))
    setDataVersion((version) => version + 1)
  }, [])

  const report = useCallback((err: unknown) => {
    setError(err instanceof RepoError ? err.message : strings.common.unexpectedReload)
  }, [])

  // 第一次進入時載入根目錄
  useEffect(() => {
    repo
      .listChildren(null)
      .then((list) => setChildrenOf((prev) => ({ ...prev, [ROOT]: list })))
      .catch(report)
  }, [report])

  const nodesById = useMemo(() => {
    const map = new Map<string, NodeMeta>()
    for (const list of Object.values(childrenOf)) {
      for (const node of list) map.set(node.id, node)
    }
    return map
  }, [childrenOf])

  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null
  // 選取的項目（看得到的）；超過一個時，右鍵選單、剪下、複製、刪除、拖曳都是整個選取一起
  const selection = [...selectedIds].flatMap((id) => nodesById.get(id) ?? [])
  const multiple = selection.length > 1

  /** 要處理的項目：在多選裡的項目就是整個選取（只留最上層，裡面的會跟著處理），不然就是它自己 */
  function itemsFor(node: NodeMeta): NodeMeta[] {
    if (!multiple || !selectedIds.has(node.id)) return [node]
    return topLevelOnly(selection, (id) => nodesById.get(id)?.parent_id)
  }

  /** 只選一個項目（null 為都不選） */
  function selectOnly(id: string | null) {
    setSelectedId(id)
    setSelectedIds(id ? new Set([id]) : new Set())
    anchor.current = id
  }
  // 新增的項目放在：資料夾裡、筆記所在的資料夾，或最上層
  const parentFor = (node: NodeMeta | null) => (node ? (node.type === 'folder' ? node.id : node.parent_id) : null)
  const placeName = (parentId: string | null) =>
    parentId ? strings.common.quoted(nodesById.get(parentId)?.name ?? '…') : strings.workspace.topLevel
  const targetParentId = parentFor(selected)

  function expand(folderId: string) {
    setExpanded((prev) => new Set(prev).add(folderId))
    if (!childrenOf[folderId]) loadChildren(folderId).catch(report)
  }

  function toggle(folder: NodeMeta) {
    if (expanded.has(folder.id)) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(folder.id)
        return next
      })
    } else {
      expand(folder.id)
    }
  }

  function select(node: NodeMeta | null, how: { toggle?: boolean; range?: boolean } = {}) {
    // ⌘／Ctrl、Shift 點選是多選：只改變選取，不打開、不展開（小螢幕沒有這些按鍵，只能單選）
    if (node && !narrow && (how.toggle || how.range)) {
      if (how.range) {
        const order = visibleOrder((parentId) => childrenOf[keyOf(parentId)], expanded)
        setSelectedIds(new Set(rangeBetween(order, anchor.current ?? selectedId, node.id)))
        return
      }
      const next = new Set(selectedIds)
      if (next.has(node.id)) next.delete(node.id)
      else next.add(node.id)
      setSelectedIds(next)
      anchor.current = node.id
      return
    }
    selectOnly(node?.id ?? null)
    if (node?.type === 'folder') {
      // 小螢幕點資料夾就是展開／收合；大螢幕點了會展開，收合用左邊的箭頭
      if (narrow) toggle(node)
      else if (!expanded.has(node.id)) expand(node.id)
    } else if (node?.type === 'note' || node?.type === 'image') {
      openDetail()
    }
  }

  /** 左側圖示欄：切換面板；按目前開著的面板就收起側欄（大螢幕） */
  function showPanel(next: Panel) {
    if (!narrow && sidebarOpen && panel === next) {
      setSidebarOpen(false)
      return
    }
    setPanel(next)
    setSidebarOpen(true)
    if (next === 'search') focusSearch()
  }

  function focusSearch() {
    requestAnimationFrame(() => {
      searchInput.current?.focus()
      searchInput.current?.select()
    })
  }

  /** ⌘⇧F／Ctrl+Shift+F：不管目前在哪個面板，都打開搜尋並選取搜尋框的字 */
  function openSearch() {
    setPanel('search')
    setSidebarOpen(true)
    if (narrow && inDetail) backToList()
    focusSearch()
  }

  const openSearchRef = useRef(openSearch)
  useEffect(() => {
    openSearchRef.current = openSearch
  })
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearchRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * 打開搜尋結果：展開上層資料夾（切回檔案總管時看得到）、選取筆記；
   * 點的是某一行時，編輯器捲到那一行
   */
  async function openResult(result: SearchResult, hit?: LineHit) {
    setError(null)
    try {
      for (const id of result.ancestors) {
        if (!childrenOf[id]) await loadChildren(id)
      }
      // 筆記所在的資料夾重新讀一次，確定讀得到這篇（例如剛同步進來的）
      await loadChildren(result.note.parent_id)
      setExpanded((prev) => new Set([...prev, ...result.ancestors]))
      selectOnly(result.note.id)
      if (hit) {
        revealCount.current += 1
        setReveal({ noteId: result.note.id, offset: hit.offset, length: hit.length, key: revealCount.current })
      }
      openDetail()
    } catch (err) {
      report(err)
    }
  }

  /** 小螢幕：進入編輯器畫面 */
  function openDetail() {
    if (!narrow || inDetail) return
    listScroll.current = window.scrollY
    window.history.pushState({ [DETAIL_STATE]: true }, '')
    setInDetail(true)
    requestAnimationFrame(() => {
      window.scrollTo(0, 0)
      backButton.current?.focus()
    })
  }

  /** 小螢幕：回到清單。有加歷史記錄就往回一頁（跟按瀏覽器的返回一樣），由 popstate 切換畫面 */
  function backToList() {
    if ((window.history.state as Record<string, unknown> | null)?.[DETAIL_STATE]) window.history.back()
    else setInDetail(false)
  }

  // 瀏覽器的返回、前進：依歷史記錄決定在哪個畫面
  useEffect(() => {
    // 在編輯器畫面重新整理後，歷史記錄還留著那一筆，先清掉
    if ((window.history.state as Record<string, unknown> | null)?.[DETAIL_STATE]) window.history.replaceState(null, '')
    const onPopState = (event: PopStateEvent) => {
      setInDetail(Boolean((event.state as Record<string, unknown> | null)?.[DETAIL_STATE]))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // 回到清單：恢復捲動位置，焦點回到剛才那篇筆記
  const wasInDetail = useRef(inDetail)
  useEffect(() => {
    if (wasInDetail.current && !inDetail) {
      requestAnimationFrame(() => {
        window.scrollTo(0, listScroll.current)
        document.querySelector<HTMLElement>('.tree-row.selected .tree-item')?.focus({ preventScroll: true })
      })
    }
    wasInDetail.current = inDetail
  }, [inDetail])

  async function expandAll() {
    setError(null)
    try {
      // 資料都在本機，一次讀出全部，組成每個資料夾的子項目清單
      const all = await repo.listAll()
      const lists: Record<string, NodeMeta[]> = { [ROOT]: [] }
      for (const { content: _content, ...meta } of all) {
        if (meta.type === 'folder') lists[meta.id] ??= []
        ;(lists[keyOf(meta.parent_id)] ??= []).push(meta)
      }
      for (const list of Object.values(lists)) sortNodes(list)
      setChildrenOf(lists)
      setExpanded(new Set(all.filter((node) => node.type === 'folder').map((node) => node.id)))
    } catch (err) {
      report(err)
    }
  }

  async function refresh() {
    setError(null)
    try {
      await Promise.all([null, ...expanded].map((id) => loadChildren(id)))
    } catch (err) {
      report(err)
    }
  }

  // 同步改到本機資料（其他裝置的修改、衝突副本、撞名改名）時，重新讀取已展開的資料夾
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })
  useEffect(() => mirror.onChange(() => void refreshRef.current()), [])

  async function handleCreate(type: NodeType, parentId: string | null, name: string) {
    const node = await repo.createNode({ parentId, type, name })
    await loadChildren(parentId)
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId))
    selectOnly(node.id)
    setDialog(null)
    // 小螢幕新增筆記後直接進入編輯器
    if (type === 'note') openDetail()
  }

  async function handleRename(node: NodeMeta, name: string) {
    await repo.updateNode(node.id, { name })
    await loadChildren(node.parent_id)
    setDialog(null)
  }

  /** 移到 targetId 資料夾（null 為最上層），完成後展開目標資料夾 */
  async function moveInto(node: NodeMeta, targetId: string | null) {
    if (node.parent_id === targetId) return
    await repo.moveNode(node.id, targetId)
    await Promise.all([loadChildren(node.parent_id), loadChildren(targetId)])
    if (targetId) setExpanded((prev) => new Set(prev).add(targetId))
  }

  /** 複製到 targetId 資料夾，回傳副本 */
  async function copyInto(node: NodeMeta, targetId: string | null): Promise<NodeMeta> {
    const duplicate = await repo.copyNode(node.id, targetId)
    await loadChildren(targetId)
    if (targetId) setExpanded((prev) => new Set(prev).add(targetId))
    return duplicate
  }

  /** 一個一個移動或複製到 targetId 資料夾；複製的話選取所有副本。遇到錯誤就停下來（前面的已經完成） */
  async function transfer(nodes: NodeMeta[], targetId: string | null, mode: 'move' | 'copy') {
    const copies: string[] = []
    try {
      for (const node of nodes) {
        if (mode === 'move') await moveInto(node, targetId)
        else copies.push((await copyInto(node, targetId)).id)
      }
    } finally {
      // 複製一個：打開副本（跟原本一樣）；複製好幾個：選取所有副本，右側維持原本打開的項目
      if (copies.length === 1) selectOnly(copies[0])
      else if (copies.length > 1) {
        setSelectedIds(new Set(copies))
        anchor.current = copies[copies.length - 1]
      }
    }
  }

  /** 貼上剪下或複製的項目（可以好幾個）。剪下的貼上一次就清掉，複製的可以貼很多次 */
  async function paste(targetId: string | null) {
    if (!clipboard) return
    setError(null)
    try {
      await transfer(clipboard.nodes, targetId, clipboard.mode === 'cut' ? 'move' : 'copy')
      if (clipboard.mode === 'cut') setClipboard(null)
    } catch (err) {
      report(err)
    }
  }

  /** 右鍵選單的「上傳圖片」：選檔案（可以多張），上傳到 parentId 資料夾 */
  function chooseImages(parentId: string | null) {
    uploadTarget.current = parentId
    uploadInput.current?.click()
  }

  /** 一張一張壓縮、上傳，再放進資料夾（撞名時自動加編號）。完成後選取最後一張 */
  async function uploadImages(files: File[], parentId: string | null) {
    if (files.length === 0) return
    setError(null)
    const failed: { name: string; message: string }[] = []
    let last: string | null = null
    for (const [index, file] of files.entries()) {
      setNotice({ text: strings.images.uploading(index + 1, files.length), busy: true })
      try {
        const image = await compressImage(file)
        const fileId = await repo.uploadImage(image.blob)
        const node = await repo.createNode({
          parentId,
          type: 'image',
          name: imageFileName(file.name, image.format),
          content: fileId,
          rename: true,
        })
        last = node.id
      } catch (err) {
        const message = err instanceof RepoError || err instanceof ImageError ? err.message : strings.editor.image.failed
        failed.push({ name: file.name, message })
      }
    }
    try {
      await loadChildren(parentId)
    } catch (err) {
      report(err)
    }
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId))
    if (last) selectOnly(last)
    if (failed.length > 0) {
      setNotice(null)
      setError(strings.images.someFailed(failed.length, failed[0].name, failed[0].message))
    } else {
      setNotice({ text: strings.images.uploaded(files.length), busy: false })
    }
  }

  /** 右鍵選單的「匯入檔案」「匯入資料夾」：選檔案（.md、圖片、ZIP，可以多選）或整個資料夾，匯入到 parentId 資料夾 */
  function chooseImport(parentId: string | null, folder: boolean) {
    const input = importInput.current
    if (!input) return
    importTarget.current = parentId
    input.webkitdirectory = folder
    input.accept = folder ? '' : '.md,.markdown,.zip,image/*'
    input.click()
  }

  /**
   * 匯入選到、拖進來的檔案到 parentId 資料夾（spec 第 3 節加分項）。
   * 完成後選取直接放進去的項目；有略過、失敗的檔案時說明原因
   */
  async function importInto(parentId: string | null, read: () => Promise<ImportSource>) {
    setError(null)
    setNotice({ text: strings.imports.reading, busy: true })
    try {
      const source = await expandZips(await read())
      const plan = planImport(source.files, source.folders)
      if (plan.folders.length + plan.notes.length + plan.images.length === 0) {
        // 沒有支援的檔案（或全部讀不到）
        const [failed] = source.failed
        setNotice(null)
        setError(failed ? strings.imports.someFailed(source.failed.length, failed.name, failed.message) : strings.imports.nothing)
        return
      }
      const result = await runImport(plan, parentId, {
        repo,
        compress: (file) => keepOrCompress(file),
        cloud,
        onProgress: (done, total) => setNotice({ text: strings.imports.progress(done, total), busy: true }),
      })
      await loadChildren(parentId).catch(report)
      if (parentId) setExpanded((prev) => new Set(prev).add(parentId))
      const [first, ...rest] = result.created
      if (first && rest.length === 0) {
        selectOnly(first.id)
        if (first.type === 'folder') expand(first.id)
      } else if (first) {
        setSelectedIds(new Set(result.created.map((node) => node.id)))
        anchor.current = result.created[result.created.length - 1].id
      }

      const failed = [...source.failed, ...result.failed]
      if (failed.length > 0) setError(strings.imports.someFailed(failed.length, failed[0].name, failed[0].message))
      const extra = [
        result.skipped > 0 && strings.imports.skipped(result.skipped),
        result.offlineImages > 0 && strings.imports.offlineImages(result.offlineImages),
      ].filter((text): text is string => Boolean(text))
      setNotice({
        text: [strings.imports.done(result.folders, result.notes, result.images), ...extra].join(' '),
        busy: false,
        sticky: extra.length > 0,
      })
    } catch (err) {
      setNotice(null)
      setError(err instanceof ImportError ? err.message : strings.common.unexpectedReload)
    }
  }

  // 上傳、匯入完成的訊息幾秒後消失
  useEffect(() => {
    if (!notice || notice.busy || notice.sticky) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /** 游標下的項目：資料夾就放進去，筆記就放進它所在的資料夾 */
  const dropTargetOf = (node: NodeMeta | null) => parentFor(node)

  /** targetId 是不是 node 自己或它的子孫（不能放進去） */
  function isInside(node: NodeMeta, targetId: string | null): boolean {
    for (let current = targetId; current; current = nodesById.get(current)?.parent_id ?? null) {
      if (current === node.id) return true
    }
    return false
  }

  function clearDrag() {
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer)
    expandTimer.current = null
    setDragging(null)
    setDropTarget(undefined)
  }

  /** 從電腦拖進來的檔案、資料夾（匯入） */
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  /** 游標移到 node（null 為空白處）上：可以放就標示出來，停在收合的資料夾上一會兒就展開 */
  function dragOver(node: NodeMeta | null, event: DragEvent<HTMLElement>) {
    event.stopPropagation()
    const target = dropTargetOf(node)
    if (dragging) {
      const copying = isCopyDrag(event)
      // 自己裡面不能放；全部都移動到原本的位置沒有意義（複製可以，會變成「 (2)」）
      if (
        dragging.some((item) => isInside(item, target)) ||
        (!copying && dragging.every((item) => item.parent_id === target))
      ) {
        if (dropTarget !== undefined) setDropTarget(undefined)
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = copying ? 'copy' : 'move'
    } else if (isFileDrag(event)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    } else {
      return // 其他從外面拖進來的東西（例如文字）不處理
    }
    if (dropTarget !== target) setDropTarget(target)

    if (node?.type === 'folder' && !expanded.has(node.id)) {
      if (expandTimer.current?.id !== node.id) {
        if (expandTimer.current) window.clearTimeout(expandTimer.current.timer)
        expandTimer.current = { id: node.id, timer: window.setTimeout(() => expand(node.id), DRAG_EXPAND_MS) }
      }
    } else if (expandTimer.current) {
      window.clearTimeout(expandTimer.current.timer)
      expandTimer.current = null
    }
  }

  async function drop(node: NodeMeta | null, event: DragEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    const source = dragging
    const target = dropTargetOf(node)
    const copying = isCopyDrag(event)
    clearDrag()
    if (!source && isFileDrag(event)) {
      // 要在 drop 事件裡先取出拖進來的項目，事件結束後就讀不到了
      const entries = entriesFromDrop(event.dataTransfer)
      void importInto(target, () => readDropped(entries))
      return
    }
    if (!source || source.some((item) => isInside(item, target))) return
    setError(null)
    try {
      // 移動時，已經在目標資料夾的跳過
      await transfer(copying ? source : source.filter((item) => item.parent_id !== target), target, copying ? 'copy' : 'move')
    } catch (err) {
      report(err)
    }
  }

  const treeDrag: TreeDrag | undefined = CAN_DRAG
    ? {
        onDragStart(node, event) {
          // 拖的是多選裡的項目就整個選取一起拖；拖到編輯區時用換行分隔的 id 插入所有圖片
          const items = itemsFor(node)
          event.dataTransfer.setData(NODE_DRAG_TYPE, items.map((item) => item.id).join('\n'))
          event.dataTransfer.effectAllowed = 'copyMove'
          setDragging(items)
        },
        onDragOver: dragOver,
        onDrop: (node, event) => void drop(node, event),
        onDragEnd: clearDrag,
      }
    : undefined

  async function handleDelete(nodes: NodeMeta[]) {
    try {
      for (const node of nodes) await repo.deleteNode(node.id)
    } finally {
      await Promise.all([...new Set(nodes.map((node) => node.parent_id))].map((parentId) => loadChildren(parentId)))
    }
    selectOnly(null)
    setDialog(null)
  }

  // 儲存筆記後，用資料庫回傳的最新資料（updated_at、version）更新樹狀清單
  const replaceNode = useCallback((node: NodeMeta) => {
    setChildrenOf((prev) => {
      const key = keyOf(node.parent_id)
      const list = prev[key]
      if (!list) return prev
      return { ...prev, [key]: list.map((item) => (item.id === node.id ? node : item)) }
    })
    setDataVersion((version) => version + 1)
  }, [])

  const closeDialog = () => setDialog(null)
  const openCreate = (type: NodeType, parentId: string | null) => setDialog({ kind: 'create', type, parentId })

  /**
   * 右鍵選單的項目。資料夾：新增、剪下／複製／貼上、改名、刪除；筆記沒有新增（貼上會放進它所在的資料夾）；
   * 空白處：新增、貼上到最上層。移動用剪下、貼上或拖曳
   */
  function menuItemsFor(node: NodeMeta | null): MenuItems {
    const text = strings.workspace.contextMenu
    // 在多選的項目上按右鍵：整個選取一起剪下、複製、刪除（不能改名、新增）
    if (node && multiple && selectedIds.has(node.id)) {
      const items = itemsFor(node)
      return [
        { label: text.cut, icon: <Icon of={IconCut} />, shortcut: shortcut('X'), onSelect: () => setClipboard({ mode: 'cut', nodes: items }) },
        { label: text.copy, icon: <Icon of={IconCopy} />, shortcut: shortcut('C'), onSelect: () => setClipboard({ mode: 'copy', nodes: items }) },
        'separator',
        {
          label: text.deleteMany(selection.length),
          icon: <Icon of={IconTrash} />,
          shortcut: IS_MAC ? '⌘⌫' : 'Delete',
          danger: true,
          onSelect: () => setDialog({ kind: 'delete', nodes: items }),
        },
      ]
    }
    const parentId = parentFor(node)
    const create: MenuItems = [
      { label: text.newNote, icon: <Icon of={IconFilePlus} />, onSelect: () => openCreate('note', parentId) },
      { label: text.newFolder, icon: <Icon of={IconFolderPlus} />, onSelect: () => openCreate('folder', parentId) },
      'separator',
      {
        label: cloud ? text.uploadImages : text.uploadImagesOffline,
        icon: <Icon of={IconPhotoUp} />,
        disabled: !cloud,
        onSelect: () => chooseImages(parentId),
      },
      { label: text.importFiles, icon: <Icon of={IconFileImport} />, onSelect: () => chooseImport(parentId, false) },
      { label: text.importFolder, icon: <Icon of={IconFolderUp} />, onSelect: () => chooseImport(parentId, true) },
    ]
    const pasteItem: MenuItems[number] = {
      label: text.paste,
      icon: <Icon of={IconClipboard} />,
      shortcut: shortcut('V'),
      disabled: !clipboard,
      onSelect: () => void paste(parentId),
    }
    if (!node) return [...create, 'separator', pasteItem]
    const clip: MenuItems = [
      { label: text.cut, icon: <Icon of={IconCut} />, shortcut: shortcut('X'), onSelect: () => setClipboard({ mode: 'cut', nodes: [node] }) },
      { label: text.copy, icon: <Icon of={IconCopy} />, shortcut: shortcut('C'), onSelect: () => setClipboard({ mode: 'copy', nodes: [node] }) },
      pasteItem,
    ]
    const edit: MenuItems = [
      { label: text.rename, icon: <Icon of={IconPencil} />, shortcut: 'F2', onSelect: () => setDialog({ kind: 'rename', node }) },
      'separator',
      {
        label: text.delete,
        icon: <Icon of={IconTrash} />,
        shortcut: IS_MAC ? '⌘⌫' : 'Delete',
        danger: true,
        onSelect: () => setDialog({ kind: 'delete', nodes: [node] }),
      },
    ]
    return node.type === 'folder' ? [...create, 'separator', ...clip, 'separator', ...edit] : [...clip, 'separator', ...edit]
  }

  const menuTrigger = useContextMenuTrigger((node: NodeMeta | null, x: number, y: number) => {
    setMenu({
      x,
      y,
      label: !node
        ? strings.workspace.contextMenu.topLevelLabel
        : multiple && selectedIds.has(node.id)
          ? strings.workspace.contextMenu.selectionLabel(selection.length)
          : strings.workspace.contextMenu.label(node.name),
      items: menuItemsFor(node),
      targetId: node?.id ?? null,
    })
  })

  /**
   * 樹的快捷鍵：剪下／複製／貼上、F2 改名、Delete 刪除、右鍵頭展開、左鍵頭收合、Esc 取消剪下或多選。
   * 剪下、複製、刪除在多選的項目上時，整個選取一起處理
   */
  function handleItemKeyDown(node: NodeMeta, event: KeyboardEvent<HTMLElement>) {
    const isFolder = node.type === 'folder'
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'x') {
      setClipboard({ mode: 'cut', nodes: itemsFor(node) })
    } else if (mod && key === 'c') {
      setClipboard({ mode: 'copy', nodes: itemsFor(node) })
    } else if (mod && key === 'v') {
      void paste(parentFor(node))
    } else if (event.key === 'Escape' && clipboard?.mode === 'cut') {
      setClipboard(null)
    } else if (event.key === 'Escape' && multiple) {
      // 取消多選：只留打開的項目
      setSelectedIds(selectedId ? new Set([selectedId]) : new Set())
      anchor.current = selectedId
    } else if (event.key === 'F2') {
      setDialog({ kind: 'rename', node })
    } else if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      setDialog({ kind: 'delete', nodes: itemsFor(node) })
    } else if (event.key === 'ArrowRight' && isFolder && !expanded.has(node.id)) {
      expand(node.id)
    } else if (event.key === 'ArrowLeft' && isFolder && expanded.has(node.id)) {
      toggle(node)
    } else {
      return
    }
    event.preventDefault()
  }

  const anyExpanded = expanded.size > 0
  // 小螢幕目前的畫面：選了筆記或圖片、而且點進去之後才是編輯器或圖片預覽
  const screen = narrow && inDetail && (selected?.type === 'note' || selected?.type === 'image') ? 'detail' : 'list'

  /**
   * 標題區：所在的資料夾路徑、名稱。筆記的話由 NoteEditor 呼叫，把儲存狀態與編輯器的圖示放在名稱同一行，
   * 編輯區、預覽可以多一點空間
   */
  const renderHeader = (node: NodeMeta) => (inline?: ReactNode) => (
    <header className="detail-header">
      {narrow && (
        <IconButton
          ref={backButton}
          icon={IconChevronLeft}
          label={strings.workspace.back}
          className="icon-button back-button"
          size={22}
          onClick={backToList}
        />
      )}
      <p className="detail-path">
        <span className="visually-hidden">{strings.workspace.location}</span>
        {folderPath(node.parent_id, (id) => nodesById.get(id))}
      </p>
      <div className="detail-title-row">
        <h2 className="detail-title">{node.name}</h2>
        {inline}
      </div>
    </header>
  )

  return (
    <div className={sidebarOpen ? 'workspace' : 'workspace sidebar-hidden'} data-screen={screen}>
      <nav className="activity-bar" aria-label={strings.workspace.activityBar}>
        <IconButton
          icon={IconFiles}
          label={strings.workspace.explorer}
          className="activity-button"
          size={24}
          pressed={sidebarOpen && panel === 'explorer'}
          onClick={() => showPanel('explorer')}
        />
        <IconButton
          icon={IconSearch}
          label={strings.search.title}
          title={strings.search.buttonHint(SEARCH_SHORTCUT)}
          className="activity-button"
          size={24}
          pressed={sidebarOpen && panel === 'search'}
          onClick={() => showPanel('search')}
        />
      </nav>

      <aside className="sidebar" aria-label={panel === 'search' ? strings.search.title : strings.workspace.explorer}>
        {panel === 'search' ? (
          <>
            <SearchPanel
              query={searchQuery}
              onQueryChange={setSearchQuery}
              version={dataVersion}
              narrow={narrow}
              onShowExplorer={() => setPanel('explorer')}
              onOpen={(result, hit) => void openResult(result, hit)}
              inputRef={searchInput}
            />
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <header className="panel-header">
              <h2 className="panel-title">{strings.workspace.explorer}</h2>
              <div className="panel-actions">
                {/* 小螢幕沒有左側圖示欄，搜尋放在這裡 */}
                {narrow && <IconButton icon={IconSearch} label={strings.search.title} onClick={() => showPanel('search')} />}
                <IconButton
                  icon={IconFilePlus}
                  label={strings.workspace.newNoteIn(placeName(targetParentId))}
                  onClick={() => openCreate('note', targetParentId)}
                />
                <IconButton
                  icon={IconFolderPlus}
                  label={strings.workspace.newFolderIn(placeName(targetParentId))}
                  onClick={() => openCreate('folder', targetParentId)}
                />
                <IconButton
                  icon={IconRefresh}
                  label={strings.workspace.refresh}
                  onClick={() => {
                    void mirror.sync()
                    void refresh()
                  }}
                />
                <IconButton
                  icon={anyExpanded ? IconLayoutNavbarCollapse : IconLayoutNavbarExpand}
                  label={anyExpanded ? strings.workspace.collapseAll : strings.workspace.expandAll}
                  onClick={() => (anyExpanded ? setExpanded(new Set()) : void expandAll())}
                />
              </div>
            </header>

            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="message notice" role="status">
                {notice.text}
                {notice.sticky && (
                  <>
                    {' '}
                    <button type="button" className="link-button" onClick={() => setNotice(null)}>
                      {strings.common.gotIt}
                    </button>
                  </>
                )}
              </p>
            )}

            {/* 點樹以外的空白處：選取最上層；在空白處按右鍵：新增到最上層 */}
            <nav
              className={dropTarget === null ? 'panel-body drop-root' : 'panel-body'}
              aria-label={strings.workspace.tree}
              {...menuTrigger(null)}
              onClick={(event) => {
                if (!(event.target as Element).closest('.tree-row')) select(null)
              }}
              onDragOver={(event) => dragOver(null, event)}
              onDrop={(event) => void drop(null, event)}
              onDragLeave={(event) => {
                // 拖出整個樹的範圍時取消標示
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined)
              }}
            >
              <FileTree
                childrenOf={(parentId) => childrenOf[keyOf(parentId)]}
                expanded={expanded}
                selectedIds={selectedIds}
                currentId={selectedId}
                menuTargetId={menu?.targetId}
                onSelect={select}
                onToggle={toggle}
                menuTrigger={menuTrigger}
                onItemKeyDown={handleItemKeyDown}
                cutIds={clipboard?.mode === 'cut' ? new Set(clipboard.nodes.map((node) => node.id)) : undefined}
                drag={treeDrag}
                dropTargetId={dropTarget}
              />
            </nav>
          </>
        )}

        <footer className="panel-footer">
          <SyncStatus />
        </footer>
      </aside>

      <main className="detail">
        {selected?.type === 'image' ? (
          <ImageViewer
            key={selected.id}
            nodeId={selected.id}
            name={selected.name}
            cloud={cloud}
            renderHeader={renderHeader(selected)}
          />
        ) : selected?.type === 'note' ? (
          <NoteEditor
            key={selected.id}
            noteId={selected.id}
            cloud={cloud}
            onSaved={replaceNode}
            renderHeader={renderHeader(selected)}
            reveal={reveal?.noteId === selected.id ? reveal : undefined}
            folderId={selected.parent_id}
            version={dataVersion}
            onImageCreated={(parentId) => void loadChildren(parentId).catch(report)}
          />
        ) : selected ? (
          <>
            {renderHeader(selected)()}
            <p className="detail-placeholder">
              {childrenOf[selected.id] ? strings.workspace.folderItems(childrenOf[selected.id].length) : ''}
              {strings.workspace.folderHelp}
            </p>
          </>
        ) : (
          <p className="detail-placeholder">
            {strings.workspace.noSelection}
          </p>
        )}
      </main>

      {dialog?.kind === 'create' && (
        <NameDialog
          title={strings.workspace.dialogs.createTitle(TYPE_LABEL[dialog.type])}
          hint={strings.workspace.dialogs.createHint(placeName(dialog.parentId))}
          submitLabel={strings.workspace.dialogs.create}
          onSubmit={(name) => handleCreate(dialog.type, dialog.parentId, name)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={strings.workspace.dialogs.renameTitle(TYPE_LABEL[dialog.node.type])}
          initialName={dialog.node.name}
          submitLabel={strings.workspace.dialogs.save}
          onSubmit={(name) => handleRename(dialog.node, name)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={
            dialog.nodes.length === 1
              ? strings.workspace.dialogs.deleteTitle(TYPE_LABEL[dialog.nodes[0].type])
              : strings.workspace.dialogs.deleteManyTitle(dialog.nodes.length)
          }
          confirmLabel={strings.workspace.dialogs.delete}
          danger
          onConfirm={() => handleDelete(dialog.nodes)}
          onClose={closeDialog}
        >
          <p>
            {dialog.nodes.length > 1
              ? strings.workspace.dialogs.deleteMany(dialog.nodes.length)
              : dialog.nodes[0].type === 'folder'
                ? strings.workspace.dialogs.deleteFolder(dialog.nodes[0].name)
                : dialog.nodes[0].type === 'image'
                  ? strings.workspace.dialogs.deleteImage(dialog.nodes[0].name)
                  : strings.workspace.dialogs.deleteNote(dialog.nodes[0].name)}
            {strings.workspace.dialogs.noTrash}
          </p>
        </ConfirmDialog>
      )}
      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
      <input
        ref={uploadInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void uploadImages(files, uploadTarget.current)
        }}
      />
      {/* 匯入檔案、匯入資料夾共用（chooseImport 切換 webkitdirectory 與 accept） */}
      <input
        ref={importInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) void importInto(importTarget.current, async () => filesFromInput(files))
        }}
      />
    </div>
  )
}
