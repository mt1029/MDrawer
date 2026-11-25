import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatTime } from '../lib/format.ts'
import { RepoError, mirror, repo, type NodeMeta, type NodeType } from '../lib/repo.ts'
import { useMirror } from '../lib/useMirror.ts'
import ConfirmDialog from './ConfirmDialog.tsx'
import FileTree from './FileTree.tsx'
import MoveDialog from './MoveDialog.tsx'
import NameDialog from './NameDialog.tsx'
import NoteEditor from './NoteEditor.tsx'

const ROOT = 'root'
const keyOf = (parentId: string | null) => parentId ?? ROOT

type DialogState =
  | { kind: 'create'; type: NodeType; parentId: string | null }
  | { kind: 'rename'; node: NodeMeta }
  | { kind: 'move'; node: NodeMeta }
  | { kind: 'delete'; node: NodeMeta }

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
      {status && <p className="toolbar-hint">{status}</p>}
      {syncError && !syncing && (
        <p className="toolbar-hint sync-warning">
          同步失敗：{syncError}{' '}
          <button type="button" className="link-button" onClick={() => void mirror.sync()}>
            重試
          </button>
        </p>
      )}
      {failures.length > 0 && (
        <p className="toolbar-hint sync-warning">
          {failures.length} 項修改無法同步：{failures[0].message}
        </p>
      )}
      {conflicts.length > 0 && (
        <p className="toolbar-hint sync-warning" role="status">
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

/** 登入後的主畫面：左側資料夾樹，右側顯示選取的項目 */
export default function Workspace({ cloud }: Props) {
  // 每個資料夾已載入的子項目，key 為資料夾 id，根目錄為 ROOT
  const [childrenOf, setChildrenOf] = useState<Record<string, NodeMeta[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  // 新增的項目放在：選取的資料夾裡、選取筆記所在的資料夾，或根目錄
  const targetParentId = selected ? (selected.type === 'folder' ? selected.id : selected.parent_id) : null
  const targetParentName = targetParentId ? (nodesById.get(targetParentId)?.name ?? '…') : '最上層'

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

  async function handleMove(node: NodeMeta, targetId: string | null) {
    await repo.moveNode(node.id, targetId)
    await Promise.all([loadChildren(node.parent_id), loadChildren(targetId)])
    if (targetId) setExpanded((prev) => new Set(prev).add(targetId))
    setDialog(null)
  }

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

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="toolbar">
          <button type="button" onClick={() => setDialog({ kind: 'create', type: 'folder', parentId: targetParentId })}>
            新資料夾
          </button>
          <button type="button" onClick={() => setDialog({ kind: 'create', type: 'note', parentId: targetParentId })}>
            新筆記
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!selected}
            onClick={() => selected && setDialog({ kind: 'rename', node: selected })}
          >
            重新命名
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!selected}
            onClick={() => selected && setDialog({ kind: 'move', node: selected })}
          >
            移動
          </button>
          <button
            type="button"
            className="secondary danger-text"
            disabled={!selected}
            onClick={() => selected && setDialog({ kind: 'delete', node: selected })}
          >
            刪除
          </button>
          <button type="button" className="secondary" onClick={refresh}>
            重新整理
          </button>
        </div>
        <p className="toolbar-hint">新增到：{targetParentName}</p>
        <SyncStatus />

        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}

        <nav aria-label="資料夾樹">
          <FileTree
            childrenOf={(parentId) => childrenOf[keyOf(parentId)]}
            expanded={expanded}
            selectedId={selectedId}
            onSelect={select}
            onToggle={toggle}
          />
        </nav>
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
                按「新資料夾」或「新筆記」會建立在這個資料夾裡。
              </p>
            )}
          </>
        ) : (
          <p className="detail-placeholder">選擇一個資料夾或筆記。新增的項目會放在目前選取的資料夾裡。</p>
        )}
      </main>

      {dialog?.kind === 'create' && (
        <NameDialog
          title={`新增${TYPE_LABEL[dialog.type]}`}
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
      {dialog?.kind === 'move' && (
        <MoveDialog node={dialog.node} onSubmit={(targetId) => handleMove(dialog.node, targetId)} onClose={closeDialog} />
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
    </div>
  )
}
