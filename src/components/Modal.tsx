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
    if (dialog && !dialog.open) dialog.showModal()
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
