import { IconCheck } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MENU_ICON_SHIFT } from './iconOptics.ts'
import { Icon } from './icons.tsx'

// 選單的圖示（18px）整欄往左移，讓圖示看起來的左緣對齊標題文字的左邊
const MENU_ICON_OFFSET = `${((MENU_ICON_SHIFT * 18) / 24).toFixed(2)}px`

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
  /** 單選項目（例如編輯器的顯示方式）：true 為目前選取的，右邊打勾 */
  checked?: boolean
}

export type MenuItems = (MenuEntry | 'separator')[]

export interface MenuRequest {
  x: number
  y: number
  /** 選單的名稱，給螢幕閱讀器 */
  label: string
  items: MenuItems
  /** 'end'：選單的右邊對齊 x（從右上角的按鈕往下開） */
  align?: 'start' | 'end'
  /** 選單最上面的說明（例如帳號的 email），不能選 */
  header?: ReactNode
  /** 開選單的按鈕：在它上面按下時不算「點選單外面」，讓按鈕自己切換開關 */
  anchor?: HTMLElement | null
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
    const x = request.align === 'end' ? request.x - width : request.x
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN))
    const top =
      request.y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, request.y - height) : request.y
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    // 從按鈕開的選單，關閉後焦點回到按鈕（Safari 點按鈕不會讓按鈕取得焦點，不能只靠目前的焦點）
    if (!previous.current) {
      const active = document.activeElement
      previous.current = request.anchor ?? (active instanceof HTMLElement && !menu.contains(active) ? active : null)
    }
    // 有打勾的項目時，焦點放在打勾的那一項；否則放在第一項
    const items = menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')
    ;(menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? items[0])?.focus()
  }, [request])

  // 點選單外面、捲動、改變視窗大小、切到別的視窗時關閉；關閉時焦點回到原本的元素
  const anchor = request.anchor
  useEffect(() => {
    const menu = ref.current
    const close = () => onCloseRef.current()
    const outside = (event: Event) => {
      const target = event.target as Node
      if (!menu?.contains(target) && !anchor?.contains(target)) close()
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
  }, [anchor])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])
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
      // 先放在畫面最左邊量寬度（放在右邊緣附近會被擠窄），畫出來之前再移到正確的位置
      style={{ left: 0, top: request.y, '--menu-icon-shift': MENU_ICON_OFFSET } as CSSProperties}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {request.header && (
        <>
          <div className="menu-header">{request.header}</div>
          {/* 跟項目之間的分隔線用獨立的元素，不放在第一個項目上，hover 的底色才不會蓋到它 */}
          <div className="menu-separator" aria-hidden="true" />
        </>
      )}
      {request.items.map((item, index) =>
        item === 'separator' ? (
          <div key={`separator-${index}`} role="separator" className="menu-separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
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
            {item.checked && <Icon of={IconCheck} size={16} className="menu-check" />}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
