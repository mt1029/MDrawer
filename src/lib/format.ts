/** 顯示用的日期時間，例如「2026年11月25日 下午2:30」 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
}
