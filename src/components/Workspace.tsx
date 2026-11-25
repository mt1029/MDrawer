import {
  IconClipboard,
  IconCopy,
  IconCut,
  IconFilePlus,
  IconFiles,
  IconFolderPlus,
  IconLayoutNavbarCollapse,
  IconLayoutNavbarExpand,
  IconPencil,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { formatTime } from '../lib/format.ts'
import { RepoError, mirror, repo, sortNodes, type NodeMeta, type NodeType } from '../lib/repo.ts'
import { useContextMenuTrigger } from '../lib/useContextMenuTrigger.ts'
import { useMirror } from '../lib/useMirror.ts'
import ConfirmDialog from './ConfirmDialog.tsx'
import ContextMenu, { type MenuItems, type MenuRequest } from './ContextMenu.tsx'
import FileTree, { type TreeDrag } from './FileTree.tsx'
import { Icon, IconButton } from './icons.tsx'
import NameDialog from './NameDialog.tsx'
import NoteEditor from './NoteEditor.tsx'

const ROOT = 'root'
const keyOf = (parentId: string | null) => parentId ?? ROOT

type DialogState =
  | { kind: 'create'; type: NodeType; parentId: string | null }
  | { kind: 'rename'; node: NodeMeta }
  | { kind: 'delete'; node: NodeMeta }

/** 剪下或複製、還沒貼上的項目（App 自己的剪貼簿，不影響系統剪貼簿） */
type Clipboard = { mode: 'cut' | 'copy'; node: NodeMeta }

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
/** 快捷鍵的顯示文字：Mac 為 ⌘X，其他為 Ctrl+X */
const shortcut = (key: string) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`)
/** 拖曳時按住這個鍵是複製（Mac 為 Option，其他為 Ctrl），跟 VS Code 一樣 */
const COPY_KEY = IS_MAC ? '⌥ Option' : 'Ctrl'
const isCopyDrag = (event: DragEvent) => (IS_MAC ? event.altKey : event.ctrlKey)
// 只有滑鼠能拖曳；觸控裝置長按是開選單，用剪下、貼上移動
const CAN_DRAG = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
// 拖曳時游標停在收合的資料夾上多久就展開（毫秒）
const DRAG_EXPAND_MS = 700
// 拖曳的資料格式：自訂的類型，放到編輯框裡不會變成文字
const DRAG_TYPE = 'application/x-mdrawer-node'

const TYPE_LABEL: Record<NodeType, string> = { folder: '資料夾', note: '筆記' }
/** 同步狀態：等待同步的筆數、最後同步時間、失敗原因、衝突副本 */
function SyncStatus() {
  const { owner, syncing, syncError, pendingCount, failures, conflicts } = useMirror()
  let status: string
  if (pendingCount > 0) status = `${pendingCount} 項修改等待同步${syncing ? '，同步中…' : ''}`
  else if (syncing) status = '同步中…'
  else status = owner ? `已同步：${formatTime(owner.syncedAt)}` : ''

  return (
    <>
      {status && <p className="status-line">{status}</p>}
      {syncError && !syncing && (
        <p className="status-line warning">
          同步失敗：{syncError}{' '}
          <button type="button" className="link-button" onClick={() => void mirror.sync()}>
            重試
          </button>
        </p>
      )}
      {failures.length > 0 && (
        <p className="status-line warning">
          {failures.length} 項修改無法同步：{failures[0].message}
        </p>
      )}
      {conflicts.length > 0 && (
        <p className="status-line warning" role="status">
          有 {conflicts.length} 篇筆記在兩台裝置都改過。雲端的版本保留在原筆記，這台的版本另存為
          {conflicts.map((name) => `「${name}」`).join('')}，請自行合併。{' '}
          <button type="button" className="link-button" onClick={() => mirror.dismissConflicts()}>
            知道了
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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [menu, setMenu] = useState<(MenuRequest & { targetId: string | null }) | null>(null)
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)
  // 拖曳中的項目，以及要放進去的位置（資料夾 id；null 為最上層；undefined 為沒有）
  const [dragging, setDragging] = useState<NodeMeta | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined)
  const expandTimer = useRef<{ id: string; timer: number } | null>(null)

  const loadChildren = useCallback(async (parentId: string | null) => {
    const list = await repo.listChildren(parentId)
    setChildrenOf((prev) => ({ ...prev, [keyOf(parentId)]: list }))
  }, [])

  const report = useCallback((err: unknown) => {
    setError(err instanceof RepoError ? err.message : '發生未預期的錯誤，請重新整理頁面。')
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
  const placeName = (parentId: string | null) => (parentId ? `「${nodesById.get(parentId)?.name ?? '…'}」` : '最上層')
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
    if (node?.type === 'folder' && !expanded.has(node.id)) expand(node.id)
  }

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
    const copy = await repo.copyNode(node.id, targetId)
    await loadChildren(targetId)
    if (targetId) setExpanded((prev) => new Set(prev).add(targetId))
    setSelectedId(copy.id)
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
    const copy = isCopyDrag(event)
    // 自己裡面不能放；移動到原本的位置沒有意義（複製可以，會變成「 (2)」）
    if (isInside(dragging, target) || (!copy && target === dragging.parent_id)) {
      if (dropTarget !== undefined) setDropTarget(undefined)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = copy ? 'copy' : 'move'
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
    const copy = isCopyDrag(event)
    clearDrag()
    if (!source || isInside(source, target)) return
    setError(null)
    try {
      if (copy) await copyInto(source, target)
      else await moveInto(source, target)
    } catch (err) {
      report(err)
    }
  }

  const treeDrag: TreeDrag | undefined = CAN_DRAG
    ? {
        onDragStart(node, event) {
          event.dataTransfer.setData(DRAG_TYPE, node.id)
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
  }, [])

  const closeDialog = () => setDialog(null)
  const openCreate = (type: NodeType, parentId: string | null) => setDialog({ kind: 'create', type, parentId })

  /**
   * 右鍵選單的項目。資料夾：新增、剪下／複製／貼上、改名、刪除；筆記沒有新增（貼上會放進它所在的資料夾）；
   * 空白處：新增、貼上到最上層。移動用剪下、貼上或拖曳
   */
  function menuItemsFor(node: NodeMeta | null): MenuItems {
    const parentId = parentFor(node)
    const create: MenuItems = [
      { label: '新增筆記', icon: <Icon of={IconFilePlus} />, onSelect: () => openCreate('note', parentId) },
      { label: '新增資料夾', icon: <Icon of={IconFolderPlus} />, onSelect: () => openCreate('folder', parentId) },
    ]
    const pasteItem: MenuItems[number] = {
      label: '貼上',
      icon: <Icon of={IconClipboard} />,
      shortcut: shortcut('V'),
      disabled: !clipboard,
      onSelect: () => void paste(parentId),
    }
    if (!node) return [...create, 'separator', pasteItem]
    const clip: MenuItems = [
      { label: '剪下', icon: <Icon of={IconCut} />, shortcut: shortcut('X'), onSelect: () => setClipboard({ mode: 'cut', node }) },
      { label: '複製', icon: <Icon of={IconCopy} />, shortcut: shortcut('C'), onSelect: () => setClipboard({ mode: 'copy', node }) },
      pasteItem,
    ]
    const edit: MenuItems = [
      { label: '重新命名', icon: <Icon of={IconPencil} />, shortcut: 'F2', onSelect: () => setDialog({ kind: 'rename', node }) },
      'separator',
      {
        label: '刪除',
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
      label: node ? `「${node.name}」的操作` : '最上層的操作',
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

  return (
    <div className={sidebarOpen ? 'workspace' : 'workspace sidebar-hidden'}>
      <nav className="activity-bar" aria-label="面板">
        <IconButton
          icon={IconFiles}
          label="檔案總管"
          className="activity-button"
          size={24}
          pressed={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        />
      </nav>

      <aside className="sidebar" aria-label="檔案總管">
        <header className="panel-header">
          <h2 className="panel-title">檔案總管</h2>
          <div className="panel-actions">
            <IconButton
              icon={IconFilePlus}
              label={`新增筆記到${placeName(targetParentId)}`}
              onClick={() => openCreate('note', targetParentId)}
            />
            <IconButton
              icon={IconFolderPlus}
              label={`新增資料夾到${placeName(targetParentId)}`}
              onClick={() => openCreate('folder', targetParentId)}
            />
            <IconButton
              icon={IconRefresh}
              label="重新整理"
              onClick={() => {
                void mirror.sync()
                void refresh()
              }}
            />
            <IconButton
              icon={anyExpanded ? IconLayoutNavbarCollapse : IconLayoutNavbarExpand}
              label={anyExpanded ? '全部收合' : '全部展開'}
              onClick={() => (anyExpanded ? setExpanded(new Set()) : void expandAll())}
            />
          </div>
        </header>

        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}

        {/* 點樹以外的空白處：選取最上層；在空白處按右鍵：新增到最上層 */}
        <nav
          className={dropTarget === null ? 'panel-body drop-root' : 'panel-body'}
          aria-label="資料夾樹"
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

        <footer className="panel-footer">
          <SyncStatus />
        </footer>
      </aside>

      <main className="detail">
        {selected ? (
          <>
            <p className="detail-type">{TYPE_LABEL[selected.type]}</p>
            <h2 className="detail-title">{selected.name}</h2>
            <p className="detail-meta">最後修改：{formatTime(selected.updated_at)}</p>
            {selected.type === 'note' ? (
              <NoteEditor key={selected.id} noteId={selected.id} cloud={cloud} onSaved={replaceNode} />
            ) : (
              <p className="detail-placeholder">
                {childrenOf[selected.id] ? `裡面有 ${childrenOf[selected.id].length} 個項目。` : ''}
                用側欄上方的圖示或右鍵選單，可以在這個資料夾裡新增筆記或資料夾，或把剪下、複製的項目貼上到這裡。
              </p>
            )}
          </>
        ) : (
          <p className="detail-placeholder">
            從左側選一篇筆記。在資料夾或筆記上按右鍵（觸控螢幕長按）可以新增、剪下、複製、貼上、重新命名或刪除。
            {CAN_DRAG && `也可以直接拖曳到別的資料夾，按住 ${COPY_KEY} 拖曳是複製。`}
          </p>
        )}
      </main>

      {dialog?.kind === 'create' && (
        <NameDialog
          title={`新增${TYPE_LABEL[dialog.type]}`}
          hint={`會建立在${placeName(dialog.parentId)}`}
          submitLabel="建立"
          onSubmit={(name) => handleCreate(dialog.type, dialog.parentId, name)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={`重新命名${TYPE_LABEL[dialog.node.type]}`}
          initialName={dialog.node.name}
          submitLabel="儲存"
          onSubmit={(name) => handleRename(dialog.node, name)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`刪除${TYPE_LABEL[dialog.node.type]}`}
          confirmLabel="刪除"
          danger
          onConfirm={() => handleDelete(dialog.node)}
          onClose={closeDialog}
        >
          <p>
            {dialog.node.type === 'folder'
              ? `「${dialog.node.name}」和裡面所有的資料夾、筆記都會被刪除。`
              : `「${dialog.node.name}」會被刪除。`}
            目前沒有垃圾桶，刪除後無法從畫面上還原。
          </p>
        </ConfirmDialog>
      )}
      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
