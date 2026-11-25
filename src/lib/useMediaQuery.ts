import { useCallback, useSyncExternalStore } from 'react'

/** CSS media query 目前是否成立，改變視窗大小、旋轉手機時自動更新 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}
