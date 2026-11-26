import type { CSSProperties, DragEvent, HTMLAttributes, KeyboardEvent } from 'react'
import { formatTime } from '../lib/format.ts'
import type { NodeMeta } from '../lib/repo.ts'
import { strings } from '../strings.ts'
import { ChevronIcon, FolderIcon, ImageIcon, NoteIcon } from './icons.tsx'

interface Props {
  /** 某個資料夾已載入的子項目；undefined 代表還沒載入。parentId 為 null 代表根目錄 */
  childrenOf: (parentId: string | null) => NodeMeta[] | undefined
  expanded: ReadonlySet<string>
  /** 選取的項目（可以多選） */
  selectedIds: ReadonlySet<string>
  /** 目前打開的項目（右側顯示的那一個） */
  currentId: string | null
  /** 正在開右鍵選單的項目（外框標示，但不改變選取） */
  menuTargetId?: string | null
  /** 點了項目；toggle 是按住 ⌘／Ctrl（加入或取消選取），range 是按住 Shift（選一段範圍） */
  onSelect: (node: NodeMeta, how: { toggle: boolean; range: boolean }) => void
  onToggle: (node: NodeMeta) => void
  /** 右鍵、長按、選單鍵要綁在項目上的事件（開右鍵選單） */
  menuTrigger?: (node: NodeMeta) => HTMLAttributes<HTMLElement>
  /** 項目上的其他快捷鍵（例如 F2 改名、Delete 刪除） */
  onItemKeyDown?: (node: NodeMeta, event: KeyboardEvent<HTMLElement>) => void
  /** 剪下、還沒貼上的項目（變淡） */
  cutIds?: ReadonlySet<string>
  /** 拖曳：沒有傳就不能拖（觸控裝置用剪下、貼上） */
  drag?: TreeDrag
  /** 拖曳時要放進去的資料夾（標示出來）；null 為最上層 */
  dropTargetId?: string | null
}

export interface TreeDrag {
  onDragStart: (node: NodeMeta, event: DragEvent<HTMLElement>) => void
  /** node 為游標下的項目 */
  onDragOver: (node: NodeMeta, event: DragEvent<HTMLElement>) => void
  onDrop: (node: NodeMeta, event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

/** 資料夾樹。資料夾展開時才載入子項目。最上層沒有獨立的一列：點樹以外的空白處就是選最上層 */
export default function FileTree(props: Props) {
  return (
    <div className="file-tree">
      <TreeLevel {...props} parentId={null} depth={0} />
    </div>
  )
}

function depthStyle(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

function TreeLevel({ parentId, depth, ...props }: Props & { parentId: string | null; depth: number }) {
  const items = props.childrenOf(parentId)

  if (!items) {
    return (
      <p className="tree-note" style={depthStyle(depth)}>
        {strings.common.loading}
      </p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="tree-note" style={depthStyle(depth)}>
        {parentId === null ? strings.workspace.treeEmpty : strings.workspace.folderEmpty}
      </p>
    )
  }

  return (
    <ul className="tree">
      {items.map((node) => {
        const isFolder = node.type === 'folder'
        const isOpen = isFolder && props.expanded.has(node.id)
        const isSelected = props.selectedIds.has(node.id)
        const trigger = props.menuTrigger?.(node)
        return (
          <li key={node.id}>
            <div
              className={[
                'tree-row',
                isSelected && 'selected',
                props.menuTargetId === node.id && 'menu-target',
                props.cutIds?.has(node.id) && 'cut',
                isFolder && props.dropTargetId === node.id && 'drop-target',
              ]
                .filter(Boolean)
                .join(' ')}
              style={depthStyle(depth)}
              draggable={props.drag ? true : undefined}
              onDragStart={props.drag && ((event) => props.drag!.onDragStart(node, event))}
              onDragOver={props.drag && ((event) => props.drag!.onDragOver(node, event))}
              onDrop={props.drag && ((event) => props.drag!.onDrop(node, event))}
              onDragEnd={props.drag?.onDragEnd}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="tree-toggle"
                  tabIndex={-1}
                  aria-label={isOpen ? strings.workspace.collapse(node.name) : strings.workspace.expand(node.name)}
                  aria-expanded={isOpen}
                  onClick={() => props.onToggle(node)}
                >
                  <ChevronIcon open={isOpen} />
                </button>
              ) : (
                <span className="tree-toggle-spacer" />
              )}
              <button
                type="button"
                className="tree-item"
                aria-current={props.currentId === node.id ? 'true' : undefined}
                aria-expanded={isFolder ? isOpen : undefined}
                // 最後修改的時間只在游標停留時顯示，不佔畫面（觸控螢幕沒有游標停留，看不到）
                title={strings.workspace.lastModified(formatTime(node.updated_at))}
                {...trigger}
                onClick={(event) => props.onSelect(node, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })}
                onKeyDown={(event) => {
                  trigger?.onKeyDown?.(event)
                  if (!event.defaultPrevented) props.onItemKeyDown?.(node, event)
                }}
              >
                {isFolder ? <FolderIcon open={isOpen} /> : node.type === 'image' ? <ImageIcon /> : <NoteIcon />}
                <span className="tree-name">{node.name}</span>
              </button>
            </div>
            {isOpen && <TreeLevel {...props} parentId={node.id} depth={depth + 1} />}
          </li>
        )
      })}
    </ul>
  )
}
