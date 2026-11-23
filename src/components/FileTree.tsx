import type { CSSProperties } from 'react'
import type { NodeMeta } from '../lib/repo.ts'
import { ChevronIcon, FolderIcon, NoteIcon } from './icons.tsx'

interface Props {
  /** 某個資料夾已載入的子項目；undefined 代表還沒載入。parentId 為 null 代表根目錄 */
  childrenOf: (parentId: string | null) => NodeMeta[] | undefined
  expanded: ReadonlySet<string>
  selectedId: string | null
  onSelect: (node: NodeMeta | null) => void
  onToggle: (node: NodeMeta) => void
}

/** 資料夾樹。資料夾展開時才載入子項目 */
export default function FileTree(props: Props) {
  const rootSelected = props.selectedId === null
  return (
    <div className="file-tree">
      <div className={rootSelected ? 'tree-row selected' : 'tree-row'} style={depthStyle(0)}>
        <span className="tree-toggle-spacer" />
        <button
          type="button"
          className="tree-item"
          aria-current={rootSelected ? 'true' : undefined}
          onClick={() => props.onSelect(null)}
        >
          <FolderIcon />
          <span className="tree-name">最上層</span>
        </button>
      </div>
      <TreeLevel {...props} parentId={null} depth={1} />
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
        載入中…
      </p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="tree-note" style={depthStyle(depth)}>
        {parentId === null ? '還沒有任何資料夾或筆記。' : '（空資料夾）'}
      </p>
    )
  }

  return (
    <ul className="tree">
      {items.map((node) => {
        const isFolder = node.type === 'folder'
        const isOpen = isFolder && props.expanded.has(node.id)
        const isSelected = props.selectedId === node.id
        return (
          <li key={node.id}>
            <div className={isSelected ? 'tree-row selected' : 'tree-row'} style={depthStyle(depth)}>
              {isFolder ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-label={`${isOpen ? '收合' : '展開'}「${node.name}」`}
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
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => props.onSelect(node)}
              >
                {isFolder ? <FolderIcon /> : <NoteIcon />}
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
