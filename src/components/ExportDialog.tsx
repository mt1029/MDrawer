import { useState } from 'react'
import { exportAll, saveFile, type ExportProgress, type ExportResult } from '../lib/export.ts'
import { formatBytes } from '../lib/image.ts'
import { RepoError } from '../lib/repo.ts'
import Modal from './Modal.tsx'

type Phase = 'idle' | 'running' | 'done' | 'error'

function describe(progress: ExportProgress): string {
  switch (progress.stage) {
    case 'notes':
      return '讀取資料夾與筆記…'
    case 'images':
      return progress.total === 0 ? '沒有圖片需要下載…' : `下載圖片 ${progress.done} / ${progress.total}…`
    case 'zip':
      return '打包成 ZIP…'
  }
}

/** 匯出全部資料為 ZIP（spec 標準層：保留資料夾結構，圖片改為相對路徑） */
export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setPhase('running')
    setError(null)
    try {
      const exported = await exportAll((p) => setProgress(describe(p)))
      saveFile(exported.blob, exported.fileName)
      setResult(exported)
      setPhase('done')
    } catch (err) {
      setError(err instanceof RepoError ? err.message : '匯出失敗，請再試一次。')
      setPhase('error')
    }
  }

  const running = phase === 'running'

  return (
    <Modal title="匯出 ZIP" busy={running} onClose={onClose}>
      <div className="modal-body">
        {phase === 'idle' && (
          <p>
            把所有資料夾、筆記與圖片照原本的目錄結構打包成 ZIP 下載。解壓後是一般的 .md
            檔與圖片，用任何 Markdown 編輯器都能直接開啟。
          </p>
        )}

        {running && (
          <p className="modal-hint" role="status">
            {progress}
          </p>
        )}

        {phase === 'done' && result && (
          <>
            <p role="status">
              已下載 {result.fileName}（{formatBytes(result.blob.size)}）：{result.folderCount} 個資料夾、
              {result.noteCount} 篇筆記、{result.imageCount} 張圖片。
            </p>
            {result.missingImages.length > 0 && (
              <p className="message error">
                有 {result.missingImages.length} 張圖片找不到，沒有放進 ZIP。筆記裡仍保留它們的連結。
              </p>
            )}
          </>
        )}

        {phase === 'error' && error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          {phase === 'done' && result ? (
            <>
              <button type="button" className="secondary" onClick={() => saveFile(result.blob, result.fileName)}>
                再下載一次
              </button>
              <button type="button" onClick={onClose}>
                完成
              </button>
            </>
          ) : (
            <>
              <button type="button" className="secondary" onClick={onClose} disabled={running}>
                取消
              </button>
              <button type="button" onClick={start} disabled={running}>
                {running ? '匯出中…' : phase === 'error' ? '重試' : '開始匯出'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
