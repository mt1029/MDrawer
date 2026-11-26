import { useState, type FormEvent } from 'react'
import { RepoError, normalizeName, validateName } from '../lib/repo.ts'
import Modal from './Modal.tsx'
import { strings } from '../strings.ts'

interface Props {
  title: string
  /** 名稱欄下方的說明，例如會建立在哪個資料夾 */
  hint?: string
  initialName?: string
  submitLabel: string
  /** 失敗時丟出 RepoError，訊息會顯示在對話框裡 */
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}

/** 輸入名稱的對話框，用於新增與重新命名 */
export default function NameDialog({ title, hint, initialName = '', submitLabel, onSubmit, onClose }: Props) {
  const [name, setName] = useState(initialName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = normalizeName(name)
    const problem = validateName(normalized)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(normalized)
    } catch (err) {
      setError(err instanceof RepoError ? err.message : strings.common.unexpectedTryAgain)
      setBusy(false)
    }
  }

  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      <form onSubmit={handleSubmit} className="modal-body">
        <label>
          {strings.workspace.dialogs.nameLabel}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            disabled={busy}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
        </label>
        {hint && <p className="modal-hint">{hint}</p>}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            {strings.common.cancel}
          </button>
          <button type="submit" disabled={busy}>
            {busy ? strings.common.processing : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
