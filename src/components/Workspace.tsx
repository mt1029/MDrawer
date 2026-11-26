import {
  IconChevronLeft,
  IconClipboard,
  IconCopy,
  IconCut,
  IconFilePlus,
  IconFiles,
  IconFolderPlus,
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
import { ImageError, compressImage } from '../lib/image.ts'
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
  | { kind: 'delete'; node: NodeMeta }

/** 側欄的面板：檔案總管或搜尋 */
type Panel = 'explorer' | 'search'

/** 剪下或複製、還沒貼上的項目（App 自己的剪貼簿，不影響系統剪貼簿） */
type Clipboard = { mode: 'cut' | 'copy'; node: NodeMeta }

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
/** 快捷鍵的顯示文字：Mac 為 ⌘X，其他為 Ctrl+X */
const shortcut = (key: string) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`)
/** 打開搜尋的快捷鍵（跟 VS Code 一樣） */
const SEARCH_SHORTCUT = IS_MAC ? '⇧⌘F' : 'Ctrl+Shift+F'
/** 拖曳時按住這個鍵是複製（Mac 為 Option，其他為 Ctrl），跟 VS Code 一樣 */
const COPY_KEY = IS_MAC ? '⌥ Option' : 'Ctrl'
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 上傳圖片的進度與結果（側欄上方）。上傳完成的訊息幾秒後自動消失
  const [upload, setUpload] = useState<{ text: string; busy: boolean } | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string | null>(null)
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
  const [dragging, setDragging] = useState<NodeMeta | null>(null)
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

  function select(node: NodeMeta | null) {
    setSelectedId(node?.id ?? null)
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
      setSelectedId(result.note.id)
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
    setSelectedId(node.id)
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

  /** 複製到 targetId 資料夾，完成後選取副本 */
  async function copyInto(node: NodeMeta, targetId: string | null) {
    const duplicate = await repo.copyNode(node.id, targetId)
    await loadChildren(targetId)
    if (targetId) setExpanded((prev) => new Set(prev).add(targetId))
    setSelectedId(duplicate.id)
  }

  /** 貼上剪下或複製的項目。剪下的貼上一次就清掉，複製的可以貼很多次 */
  async function paste(targetId: string | null) {
    if (!clipboard) return
    setError(null)
    try {
      if (clipboard.mode === 'cut') {
        await moveInto(clipboard.node, targetId)
        setClipboard(null)
      } else {
        await copyInto(clipboard.node, targetId)
      }
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
      setUpload({ text: strings.images.uploading(index + 1, files.length), busy: true })
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
    if (last) setSelectedId(last)
    if (failed.length > 0) {
      setUpload(null)
      setError(strings.images.someFailed(failed.length, failed[0].name, failed[0].message))
    } else {
      setUpload({ text: strings.images.uploaded(files.length), busy: false })
    }
  }

  // 上傳完成的訊息幾秒後消失
  useEffect(() => {
    if (!upload || upload.busy) return
    const timer = window.setTimeout(() => setUpload(null), 4000)
    return () => window.clearTimeout(timer)
  }, [upload])

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

  /** 游標移到 node（null 為空白處）上：可以放就標示出來，停在收合的資料夾上一會兒就展開 */
  function dragOver(node: NodeMeta | null, event: DragEvent<HTMLElement>) {
    event.stopPropagation()
    if (!dragging) return // 從外面拖進來的東西（例如檔案）不處理
    const target = dropTargetOf(node)
    const copying = isCopyDrag(event)
    // 自己裡面不能放；移動到原本的位置沒有意義（複製可以，會變成「 (2)」）
    if (isInside(dragging, target) || (!copying && target === dragging.parent_id)) {
      if (dropTarget !== undefined) setDropTarget(undefined)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = copying ? 'copy' : 'move'
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
    if (!source || isInside(source, target)) return
    setError(null)
    try {
      if (copying) await copyInto(source, target)
      else await moveInto(source, target)
    } catch (err) {
      report(err)
    }
  }

  const treeDrag: TreeDrag | undefined = CAN_DRAG
    ? {
        onDragStart(node, event) {
          event.dataTransfer.setData(NODE_DRAG_TYPE, node.id)
          event.dataTransfer.effectAllowed = 'copyMove'
          setDragging(node)
        },
        onDragOver: dragOver,
        onDrop: (node, event) => void drop(node, event),
        onDragEnd: clearDrag,
      }
    : undefined

  async function handleDelete(node: NodeMeta) {
    await repo.deleteNode(node.id)
    await loadChildren(node.parent_id)
    setSelectedId(null)
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
    const parentId = parentFor(node)
    const create: MenuItems = [
      { label: text.newNote, icon: <Icon of={IconFilePlus} />, onSelect: () => openCreate('note', parentId) },
      { label: text.newFolder, icon: <Icon of={IconFolderPlus} />, onSelect: () => openCreate('folder', parentId) },
      {
        label: cloud ? text.uploadImages : text.uploadImagesOffline,
        icon: <Icon of={IconPhotoUp} />,
        disabled: !cloud,
        onSelect: () => chooseImages(parentId),
      },
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
      { label: text.cut, icon: <Icon of={IconCut} />, shortcut: shortcut('X'), onSelect: () => setClipboard({ mode: 'cut', node }) },
      { label: text.copy, icon: <Icon of={IconCopy} />, shortcut: shortcut('C'), onSelect: () => setClipboard({ mode: 'copy', node }) },
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
        onSelect: () => setDialog({ kind: 'delete', node }),
      },
    ]
    return node.type === 'folder' ? [...create, 'separator', ...clip, 'separator', ...edit] : [...clip, 'separator', ...edit]
  }

  const menuTrigger = useContextMenuTrigger((node: NodeMeta | null, x: number, y: number) => {
    setMenu({
      x,
      y,
      label: node ? strings.workspace.contextMenu.label(node.name) : strings.workspace.contextMenu.topLevelLabel,
      items: menuItemsFor(node),
      targetId: node?.id ?? null,
    })
  })

  /** 樹的快捷鍵：剪下／複製／貼上、F2 改名、Delete 刪除、右鍵頭展開、左鍵頭收合、Esc 取消剪下 */
  function handleItemKeyDown(node: NodeMeta, event: KeyboardEvent<HTMLElement>) {
    const isFolder = node.type === 'folder'
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'x') {
      setClipboard({ mode: 'cut', node })
    } else if (mod && key === 'c') {
      setClipboard({ mode: 'copy', node })
    } else if (mod && key === 'v') {
      void paste(parentFor(node))
    } else if (event.key === 'Escape' && clipboard?.mode === 'cut') {
      setClipboard(null)
    } else if (event.key === 'F2') {
      setDialog({ kind: 'rename', node })
    } else if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      setDialog({ kind: 'delete', node })
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
            {upload && (
              <p className="message notice" role="status">
                {upload.text}
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
                selectedId={selectedId}
                menuTargetId={menu?.targetId}
                onSelect={select}
                onToggle={toggle}
                menuTrigger={menuTrigger}
                onItemKeyDown={handleItemKeyDown}
                cutId={clipboard?.mode === 'cut' ? clipboard.node.id : null}
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
            {CAN_DRAG && strings.workspace.dragHelp(COPY_KEY)}
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
          title={strings.workspace.dialogs.deleteTitle(TYPE_LABEL[dialog.node.type])}
          confirmLabel={strings.workspace.dialogs.delete}
          danger
          onConfirm={() => handleDelete(dialog.node)}
          onClose={closeDialog}
        >
          <p>
            {dialog.node.type === 'folder'
              ? strings.workspace.dialogs.deleteFolder(dialog.node.name)
              : dialog.node.type === 'image'
                ? strings.workspace.dialogs.deleteImage(dialog.node.name)
                : strings.workspace.dialogs.deleteNote(dialog.node.name)}
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
    </div>
  )
}
