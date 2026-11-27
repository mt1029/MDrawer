import { IconRefresh, IconRestore, IconTrashX } from '@tabler/icons-react'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { formatTime } from '../lib/format.ts'
import { RepoError, repo, type RestoreResult, type TrashEntry } from '../lib/repo.ts'
import { rangeBetween } from '../lib/selection.ts'
import { useContextMenuTrigger } from '../lib/useContextMenuTrigger.ts'
import { strings } from '../strings.ts'
import ConfirmDialog from './ConfirmDialog.tsx'
import ContextMenu, { type MenuRequest } from './ContextMenu.tsx'
import { FolderIcon, Icon, IconButton, ImageIcon, NoteIcon } from './icons.tsx'

interface Props {
  /** 連線且已登入：垃圾桶的資料在雲端，離線時不能用 */
  cloud: boolean
  /** 小螢幕：切換到其他面板的圖示，放在標題列的最前面 */
  switcher?: ReactNode
}

type Confirm = { kind: 'purge'; entries: TrashEntry[] } | { kind: 'empty' }

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
// 跟檔案總管的刪除一樣
const DELETE_SHORTCUT = IS_MAC ? '⌘⌫' : 'Delete'

const messageOf = (err: unknown) => (err instanceof RepoError ? err.message : strings.common.unexpectedTryAgain)
/** 一筆裡面一起刪除的項目數（不含自己） */
const itemCount = (entry: TrashEntry) => entry.rows.length - 1

/**
 * 垃圾桶面板（加分層）：列出刪除的項目（同一次刪除的合成一筆，新的在前）。
 * 選取跟檔案總管一樣：點一下選取，⌘／Ctrl 點選加入或取消、Shift 點選選一段範圍；
 * 右鍵、長按、選單鍵開選單（還原、永久刪除），Delete（Mac 為 ⌘⌫）永久刪除，Esc 取消多選。
 * 標題列可以清空垃圾桶。資料在雲端，只在連線時能用
 */
export default function TrashPanel({ cloud, switcher }: Props) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  // 重新讀取時加 1
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 還原中（期間不能再操作）
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const [menu, setMenu] = useState<(MenuRequest & { id: string }) | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)

  useEffect(() => {
    if (!cloud) return
    let cancelled = false
    repo.listTrash().then(
      (list) => {
        if (cancelled) return
        setEntries(list)
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(messageOf(err))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [cloud, version])

  function reload() {
    setLoading(true)
    setVersion((value) => value + 1)
  }

  const list = cloud ? entries : null
  // 選取的（重新讀取後已經不在的不算）
  const selection = list?.filter((entry) => selectedIds.has(entry.node.id)) ?? []

  /** 要處理的：在多選裡的就是整個選取（依畫面順序），不然就是它自己 */
  const itemsFor = (entry: TrashEntry) => (selection.length > 1 && selectedIds.has(entry.node.id) ? selection : [entry])

  function selectOnly(id: string | null) {
    setSelectedIds(id ? new Set([id]) : new Set())
    anchor.current = id
  }

  /** 點選：跟檔案總管一樣，⌘／Ctrl 加入或取消、Shift 選一段範圍，其他只選這一筆 */
  function select(entry: TrashEntry, event: MouseEvent) {
    const id = entry.node.id
    if (event.shiftKey && list) {
      setSelectedIds(new Set(rangeBetween(list.map((item) => item.node.id), anchor.current, id)))
      return
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelectedIds(next)
      anchor.current = id
      return
    }
    selectOnly(id)
  }

  /** 一筆一筆還原（依畫面順序：新刪除的先，資料夾會比之前另外刪的裡面的項目先回來） */
  async function restore(targets: TrashEntry[]) {
    setBusy(true)
    setError(null)
    setNotice(strings.trash.restoring)
    const results: RestoreResult[] = []
    const report = () => {
      const [first] = results
      if (results.length === 0) setNotice(null)
      else if (results.length === 1)
        setNotice(first.movedToRoot ? strings.trash.restoredToRoot(first.name) : strings.trash.restored(first.name, targets[0].path))
      else setNotice(strings.trash.restoredMany(results.length, results.filter((result) => result.movedToRoot).length))
    }
    try {
      for (const entry of targets) results.push(await repo.restoreTrash(entry))
      selectOnly(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      report()
      setBusy(false)
      reload()
    }
  }

  async function purge(targets: TrashEntry[]) {
    const count = await repo.purgeTrash(targets)
    setError(null)
    setNotice(strings.trash.purged(count))
    setConfirm(null)
    selectOnly(null)
    reload()
  }

  // 右鍵選單：在多選的項目上是整個選取，不然只有這一筆（跟檔案總管一樣，不改變選取）
  const openMenu = (entry: TrashEntry, x: number, y: number) => {
    const targets = itemsFor(entry)
    const many = targets.length > 1
    setMenu({
      x,
      y,
      id: entry.node.id,
      label: many ? strings.trash.selectionLabel(targets.length) : strings.trash.menuLabel(entry.node.name),
      items: [
        {
          label: many ? strings.trash.restoreMany(targets.length) : strings.trash.restore,
          icon: <Icon of={IconRestore} />,
          onSelect: () => void restore(targets),
        },
        'separator',
        {
          label: many ? strings.trash.purgeMany(targets.length) : strings.trash.purge,
          icon: <Icon of={IconTrashX} />,
          shortcut: DELETE_SHORTCUT,
          danger: true,
          onSelect: () => setConfirm({ kind: 'purge', entries: targets }),
        },
      ],
    })
  }
  const menuTrigger = useContextMenuTrigger(openMenu)

  /** 快捷鍵：Delete（Mac 為 ⌘⌫）永久刪除，Esc 取消多選（只留這一筆） */
  function handleKeyDown(entry: TrashEntry, event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      setConfirm({ kind: 'purge', entries: itemsFor(entry) })
    } else if (event.key === 'Escape' && selection.length > 1) {
      selectOnly(entry.node.id)
    } else {
      return
    }
    event.preventDefault()
  }

  const confirmBody = (targets: TrashEntry[]) => {
    if (targets.length > 1) return strings.trash.purgeManyBody(targets.reduce((sum, entry) => sum + entry.rows.length, 0))
    const [entry] = targets
    return itemCount(entry) > 0 ? strings.trash.purgeFolder(entry.node.name, itemCount(entry)) : strings.trash.purgeItem(entry.node.name)
  }

  return (
    <>
      <header className="panel-header">
        <h2 className="panel-title">{strings.trash.title}</h2>
        <div className="panel-actions">
          {switcher}
          <IconButton icon={IconRefresh} label={strings.trash.refresh} disabled={!cloud || busy} onClick={reload} />
          <IconButton
            icon={IconTrashX}
            label={strings.trash.empty}
            disabled={!list || list.length === 0 || busy}
            onClick={() => setConfirm({ kind: 'empty' })}
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
          {notice}
        </p>
      )}

      {/* 點清單以外的空白處：取消選取（跟檔案總管一樣） */}
      <div
        className="panel-body trash-body"
        onClick={(event) => {
          if (!(event.target as Element).closest('.trash-item')) selectOnly(null)
        }}
      >
        {!cloud ? (
          <p className="search-hint">{strings.trash.offline}</p>
        ) : !list ? (
          loading && <p className="search-hint">{strings.trash.loading}</p>
        ) : list.length === 0 ? (
          <p className="search-hint">{strings.trash.nothing}</p>
        ) : (
          <>
            <p className="search-hint">{strings.trash.hint}</p>
            <ul className="trash-list" aria-label={strings.trash.list} aria-busy={loading}>
              {list.map((entry) => {
                const time = formatTime(entry.node.deleted_at ?? '')
                const trigger = menuTrigger(entry)
                return (
                  <li key={entry.node.id}>
                    <button
                      type="button"
                      className={[
                        'trash-item',
                        selectedIds.has(entry.node.id) && 'selected',
                        menu?.id === entry.node.id && 'menu-target',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={strings.trash.itemLabel(entry.node.name, entry.path, time)}
                      disabled={busy}
                      {...trigger}
                      onClick={(event) => select(entry, event)}
                      onKeyDown={(event) => {
                        trigger.onKeyDown(event)
                        if (!event.defaultPrevented) handleKeyDown(entry, event)
                      }}
                    >
                      {entry.node.type === 'folder' ? <FolderIcon /> : entry.node.type === 'image' ? <ImageIcon /> : <NoteIcon />}
                      <span className="trash-text">
                        <span className="trash-name">{entry.node.name}</span>
                        <span className="trash-meta">{strings.trash.meta(entry.path, time, itemCount(entry))}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'empty' ? strings.trash.emptyTitle : strings.trash.purgeTitle}
          confirmLabel={confirm.kind === 'empty' ? strings.trash.empty : strings.trash.purge}
          danger
          onConfirm={() => purge(confirm.kind === 'empty' ? (list ?? []) : confirm.entries)}
          onClose={() => setConfirm(null)}
        >
          <p>
            {confirm.kind === 'empty'
              ? strings.trash.emptyBody(list?.reduce((sum, entry) => sum + entry.rows.length, 0) ?? 0)
              : confirmBody(confirm.entries)}
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
