import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { RepoError, repo, type NodeMeta } from '../lib/repo.ts'
import { ChevronIcon, FolderIcon } from './icons.tsx'
import Modal from './Modal.tsx'

const ROOT = 'root'

interface Props {
  node: NodeMeta
  /** 失敗時丟出 RepoError，訊息會顯示在對話框裡 */
  onSubmit: (targetParentId: string | null) => Promise<void>
  onClose: () => void
}

function messageOf(err: unknown): string {
  return err instanceof RepoError ? err.message : '發生未預期的錯誤，請再試一次。'
}

/** 選擇目標資料夾。被移動的項目本身不會出現在清單裡，所以也選不到它的子孫 */
export default function MoveDialog({ node, onSubmit, onClose }: Props) {
  const [folders, setFolders] = useState<Record<string, NodeMeta[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // undefined 代表還沒選
  const [target, setTarget] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 只留資料夾，並排除被移動的項目本身
  const load = useCallback(
    (parentId: string | null) =>
      repo
        .listChildren(parentId)
        .then((list) =>
          setFolders((prev) => ({
            ...prev,
            [parentId ?? ROOT]: list.filter((item) => item.type === 'folder' && item.id !== node.id),
          })),
        )
        .catch((err: unknown) => setError(messageOf(err))),
    [node.id],
  )

  useEffect(() => {
    void load(null)
  }, [load])

  function toggle(folderId: string) {
    const next = new Set(expanded)
    if (next.has(folderId)) {
      next.delete(folderId)
    } else {
      next.add(folderId)
      if (!folders[folderId]) void load(folderId)
    }
    setExpanded(next)
  }

  async function handleSubmit() {
    if (target === undefined) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(target)
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  function option(id: string | null, label: string) {
    const isCurrent = id === node.parent_id
    const isChosen = id === target
    return (
      <button
        type="button"
        className="tree-item"
        aria-current={isChosen ? 'true' : undefined}
        disabled={isCurrent || busy}
        onClick={() => setTarget(id)}
      >
        <FolderIcon />
        <span className="tree-name">{label}</span>
        {isCurrent && <span className="tree-tag">目前位置</span>}
      </button>
    )
  }

  function level(parentId: string | null, depth: number) {
    const list = folders[parentId ?? ROOT]
    if (!list) return <p className="tree-note">載入中…</p>
    if (list.length === 0) return null
    return (
      <ul className="tree">
        {list.map((folder) => {
          const isOpen = expanded.has(folder.id)
          return (
            <li key={folder.id}>
              <div
                className={folder.id === target ? 'tree-row selected' : 'tree-row'}
                style={{ '--depth': depth } as CSSProperties}
              >
                <button
                  type="button"
                  className="tree-toggle"
                  aria-label={`${isOpen ? '收合' : '展開'}「${folder.name}」`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(folder.id)}
                >
                  <ChevronIcon open={isOpen} />
                </button>
                {option(folder.id, folder.name)}
              </div>
              {isOpen && level(folder.id, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <Modal title={`移動「${node.name}」`} busy={busy} onClose={onClose}>
      <div className="modal-body">
        <p className="modal-hint">選擇要移到哪個資料夾：</p>
        <div className="picker">
          <div className={target === null ? 'tree-row selected' : 'tree-row'}>
            <span className="tree-toggle-spacer" />
            {option(null, '最上層')}
          </div>
          {level(null, 1)}
        </div>
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" onClick={handleSubmit} disabled={target === undefined || busy}>
            {busy ? '移動中…' : '移到這裡'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
