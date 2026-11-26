import { useState } from 'react'
import { exportAll, saveFile, type ExportProgress, type ExportResult } from '../lib/export.ts'
import { formatBytes } from '../lib/image.ts'
import { RepoError } from '../lib/repo.ts'
import Modal from './Modal.tsx'
import { strings } from '../strings.ts'

type Phase = 'idle' | 'running' | 'done' | 'error'

function describe(progress: ExportProgress): string {
  switch (progress.stage) {
    case 'notes':
      return strings.export.readingNotes
    case 'images':
      return progress.total === 0 ? strings.export.noImages : strings.export.downloadingImages(progress.done, progress.total)
    case 'zip':
      return strings.export.zipping
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
      setError(err instanceof RepoError ? err.message : strings.export.failed)
      setPhase('error')
    }
  }

  const running = phase === 'running'

  return (
    <Modal title={strings.export.title} busy={running} onClose={onClose}>
      <div className="modal-body">
        {phase === 'idle' && <p>{strings.export.intro}</p>}

        {running && (
          <p className="modal-hint" role="status">
            {progress}
          </p>
        )}

        {phase === 'done' && result && (
          <>
            <p role="status">
              {strings.export.done(
                result.fileName,
                formatBytes(result.blob.size),
                result.folderCount,
                result.noteCount,
                result.imageCount,
              )}
            </p>
            {result.missingImages.length > 0 && (
              <p className="message error">
                {strings.export.missingImages(result.missingImages.length)}
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
                {strings.export.downloadAgain}
              </button>
              <button type="button" onClick={onClose}>
                {strings.export.finish}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="secondary" onClick={onClose} disabled={running}>
                {strings.common.cancel}
              </button>
              <button type="button" onClick={start} disabled={running}>
                {running ? strings.export.running : phase === 'error' ? strings.common.retry : strings.export.start}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
