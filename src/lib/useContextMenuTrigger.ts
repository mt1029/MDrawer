import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

// 長按多久開選單（毫秒），以及手指移動超過多少就當成捲動、不開選單（像素）
const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10

/**
 * 讓元素能開右鍵選單：滑鼠右鍵、觸控長按、鍵盤（選單鍵或 Shift+F10）都會呼叫 open。
 * 回傳的函式給每個元素綁定事件：<button {...bind(node)}>。
 *
 * iPhone 的 Safari 長按不會送出 contextmenu 事件，所以觸控時自己計時；
 * Android 長按會送出 contextmenu，計時先到的話就忽略它，避免開兩次。
 */
export function useContextMenuTrigger<T>(open: (target: T, x: number, y: number) => void) {
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })
  const press = useRef({ timer: 0, x: 0, y: 0, fired: false })

  const cancel = useCallback(() => window.clearTimeout(press.current.timer), [])

  return useCallback(
    (target: T) => {
      /** 從元素的位置開（鍵盤叫出的選單沒有游標位置） */
      const openAtElement = (element: Element) => {
        const rect = element.getBoundingClientRect()
        openRef.current(target, rect.left + 16, rect.bottom)
      }
      return {
        onContextMenu(event: MouseEvent<HTMLElement>) {
          event.preventDefault()
          event.stopPropagation()
          cancel()
          if (press.current.fired) return
          if (event.clientX === 0 && event.clientY === 0) openAtElement(event.currentTarget)
          else openRef.current(target, event.clientX, event.clientY)
        },
        onKeyDown(event: KeyboardEvent<HTMLElement>) {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            event.stopPropagation()
            openAtElement(event.currentTarget)
          }
        },
        onPointerDown(event: PointerEvent<HTMLElement>) {
          event.stopPropagation()
          press.current.fired = false
          if (event.pointerType === 'mouse') return
          const { clientX: x, clientY: y } = event
          cancel()
          press.current.x = x
          press.current.y = y
          press.current.timer = window.setTimeout(() => {
            press.current.fired = true
            openRef.current(target, x, y)
          }, LONG_PRESS_MS)
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          const { x, y } = press.current
          if (Math.hypot(event.clientX - x, event.clientY - y) > MOVE_TOLERANCE) cancel()
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        // 長按開了選單之後放開手指，不要再當成一般的點擊
        onClickCapture(event: MouseEvent<HTMLElement>) {
          if (press.current.fired) {
            event.preventDefault()
            event.stopPropagation()
            press.current.fired = false
          }
        },
      }
    },
    [cancel],
  )
}
