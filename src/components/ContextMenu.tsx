import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuEntry {
  label: string
  icon: ReactNode
  onSelect: () => void
  /** 刪除這類無法復原的操作，用紅字 */
  danger?: boolean
  /** 暫時不能用（例如還沒剪下或複製時的「貼上」）：顯示但不能選 */
  disabled?: boolean
  /** 快捷鍵說明，顯示在右邊，例如 ⌘C */
  shortcut?: string
}

export type MenuItems = (MenuEntry | 'separator')[]

export interface MenuRequest {
  x: number
  y: number
  /** 選單的名稱，給螢幕閱讀器 */
  label: string
  items: MenuItems
}

// 選單離畫面邊緣至少留多少空間（像素）
const MARGIN = 8

/**
 * 右鍵選單（圖示加文字）。開在游標或元素的位置，超出畫面時往內移。
 * 鍵盤：上下鍵移動、Home／End、Enter 執行、Esc 或 Tab 關閉；關閉後焦點回到開選單前的元素。
 */
export default function ContextMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // 開選單前焦點所在的元素，關閉時拉回去。要在選單的第一項取得焦點之前記下來
  const previous = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // 畫出來之前先算好位置，放不下就往左、往上移
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    const left = Math.max(MARGIN, Math.min(request.x, window.innerWidth - width - MARGIN))
    const top =
      request.y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, request.y - height) : request.y
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    if (!previous.current && document.activeElement instanceof HTMLElement && !menu.contains(document.activeElement)) {
      previous.current = document.activeElement
    }
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [request])

  // 點選單外面、捲動、改變視窗大小、切到別的視窗時關閉；關閉時焦點回到原本的元素
  useEffect(() => {
    const menu = ref.current
    const close = () => onCloseRef.current()
    const outside = (event: Event) => {
      if (!menu?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      // 焦點還在選單裡（或已經掉到 body）才拉回去，不要搶走對話框或使用者剛點的元素的焦點
      const back = previous.current
      const active = document.activeElement
      if (back?.isConnected && (!active || active === document.body || menu?.contains(active))) back.focus()
    }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus()
    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1)
        break
      case 'ArrowUp':
        focus(index - 1)
        break
      case 'Home':
        focus(0)
        break
      case 'End':
        focus(items.length - 1)
        break
      case 'Escape':
      case 'Tab':
        onClose()
        break
      default:
        return
    }
    event.preventDefault()
  }

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={request.label}
      style={{ left: request.x, top: request.y }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {request.items.map((item, index) =>
        item === 'separator' ? (
          <div key={`separator-${index}`} role="separator" className="menu-separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={item.danger ? 'menu-item menu-danger' : 'menu-item'}
            disabled={item.disabled}
            onClick={() => {
              // 先關選單（焦點回到原本的元素），再執行；開對話框時，對話框關閉後焦點才會回到正確的位置
              onClose()
              item.onSelect()
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut && <kbd className="menu-shortcut">{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
