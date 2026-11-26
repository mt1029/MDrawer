import { useState, type ReactNode } from 'react'
import { RepoError } from '../lib/repo.ts'
import Modal from './Modal.tsx'
import { strings } from '../strings.ts'

interface Props {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}

export default function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onClose }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleConfirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof RepoError ? err.message : strings.common.unexpectedTryAgain)
      setBusy(false)
    }
  }

  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      <div className="modal-body">
        {children}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            {strings.common.cancel}
          </button>
          <button type="button" className={danger ? 'danger' : undefined} onClick={handleConfirm} disabled={busy}>
            {busy ? strings.common.processing : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
