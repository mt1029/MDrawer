import { useSyncExternalStore } from 'react'
import { mirror, type MirrorState } from './repo.ts'

/** 離線副本的狀態（擁有者、最後更新時間、是否正在下載），變動時自動更新畫面 */
export function useMirror(): MirrorState {
  return useSyncExternalStore(mirror.subscribe, mirror.getState)
}
