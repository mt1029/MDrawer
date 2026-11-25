// 圖示一律用 Tabler Icons（spec 第 3 節圖示規則），統一線條粗細與尺寸。
// 圖示只是裝飾，按鈕的說明放在按鈕的 aria-label 與 title，所以這裡一律 aria-hidden。

import { IconChevronRight, IconFolder, IconFolderOpen, IconMarkdown, type Icon as TablerIcon } from '@tabler/icons-react'

/** 細線條，配合主題的 0.5px 細線與細字重 */
const STROKE = 1.5

/** 以統一的粗細畫出 Tabler 圖示 */
export function Icon({ of: Component, size = 18, className }: { of: TablerIcon; size?: number; className?: string }) {
  return <Component size={size} stroke={STROKE} className={className} aria-hidden="true" focusable="false" />
}

export function FolderIcon({ open = false }: { open?: boolean }) {
  return <Icon of={open ? IconFolderOpen : IconFolder} size={16} />
}

export function NoteIcon() {
  return <Icon of={IconMarkdown} size={16} />
}

export function ChevronIcon({ open }: { open: boolean }) {
  return <Icon of={IconChevronRight} size={16} className={open ? 'chevron open' : 'chevron'} />
}

/** 只有圖示的按鈕：說明放在 title（游標停留時顯示）與 aria-label（給螢幕閱讀器） */
export function IconButton({
  icon,
  label,
  onClick,
  className = 'icon-button',
  size,
  pressed,
}: {
  icon: TablerIcon
  label: string
  onClick: () => void
  className?: string
  size?: number
  /** 切換型的按鈕（例如顯示／隱藏側欄）目前是否為開啟 */
  pressed?: boolean
}) {
  return (
    <button type="button" className={className} aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
      <Icon of={icon} size={size} />
    </button>
  )
}
