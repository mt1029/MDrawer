import { useEffect, useId, useRef, type ReactNode } from 'react'

interface Props {
  title: string
  /** 處理中時按 Esc 不會關閉 */
  busy?: boolean
  onClose: () => void
  children: ReactNode
}

/** 以原生 <dialog> 實作的對話框：自帶焦點鎖定、Esc 關閉、背景不可操作 */
export default function Modal({ title, busy = false, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    // 對話框是直接從畫面移除（不是呼叫 close()），瀏覽器不會把焦點還回去，要自己記下來
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      const active = document.activeElement
      if (previous?.isConnected && (!active || active === document.body)) previous.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClose={onClose}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  )
}
