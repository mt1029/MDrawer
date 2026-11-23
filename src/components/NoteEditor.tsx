import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { ImageError, compressImage, formatBytes, type ImageFormat } from '../lib/image.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import { RepoError, repo, type NodeMeta } from '../lib/repo.ts'
import { useImageUrls } from '../lib/useImageUrls.ts'

// 停止輸入多久後自動儲存
const AUTOSAVE_DELAY_MS = 1000

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
type View = 'edit' | 'preview'
type ImageStatus = { kind: 'busy' | 'done' | 'error'; text: string }

const FORMAT_LABEL: Record<ImageFormat, string> = { 'image/webp': 'WebP', 'image/jpeg': 'JPEG' }

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已儲存',
  dirty: '尚未儲存',
  saving: '儲存中…',
  error: '儲存失敗',
}

interface Props {
  noteId: string
  /** 儲存成功後回傳最新的資料（version、updated_at 已由資料庫更新） */
  onSaved: (node: NodeMeta) => void
}

/** 筆記編輯器：左邊寫 Markdown，右邊即時預覽；停止輸入一秒後自動儲存 */
export default function NoteEditor({ noteId, onSaved }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [view, setView] = useState<View>('edit')
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // 用 ref 保存最新值，讓計時器與卸載時的儲存拿得到
  const latest = useRef('')
  const lastSaved = useRef('')
  const saving = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  const onSavedRef = useRef(onSaved)
  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])

  useEffect(() => {
    mounted.current = true
    repo
      .getNode(noteId)
      .then((node) => {
        if (!mounted.current) return
        if (!node) {
          setLoadError('找不到這篇筆記，可能已經被刪除。')
          return
        }
        latest.current = lastSaved.current = node.content ?? ''
        setContent(latest.current)
      })
      .catch((err: unknown) => {
        if (mounted.current) setLoadError(err instanceof RepoError ? err.message : '載入筆記失敗。')
      })
    return () => {
      mounted.current = false
    }
  }, [noteId])

  const save = useCallback(async () => {
    window.clearTimeout(timer.current)
    // 正在存的時候不重疊送出；迴圈會接著把存的過程中新打的內容也存掉
    if (saving.current) return
    saving.current = true
    try {
      while (latest.current !== lastSaved.current) {
        const text = latest.current
        if (mounted.current) setSaveState('saving')
        try {
          const node = await repo.updateNode(noteId, { content: text })
          lastSaved.current = text
          onSavedRef.current(node)
          if (mounted.current) setSaveError(null)
        } catch (err) {
          if (mounted.current) {
            setSaveState('error')
            setSaveError(err instanceof RepoError ? err.message : '發生未預期的錯誤。')
          }
          return
        }
      }
      if (mounted.current) setSaveState('saved')
    } finally {
      saving.current = false
    }
  }, [noteId])

  // 切換筆記或登出時，把還沒存的內容送出
  useEffect(() => {
    return () => {
      window.clearTimeout(timer.current)
      if (latest.current !== lastSaved.current) void save()
    }
  }, [save])

  // 有未儲存的修改時，關閉分頁前提醒
  useEffect(() => {
    if (saveState === 'saved') return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saveState])

  function handleChange(value: string) {
    setContent(value)
    latest.current = value
    setSaveState('dirty')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS)
  }

  /** 在游標位置插入文字（有選取時取代選取的文字） */
  function insertAtCursor(text: string) {
    const value = latest.current
    const start = textarea.current?.selectionStart ?? value.length
    const end = textarea.current?.selectionEnd ?? value.length
    handleChange(value.slice(0, start) + text + value.slice(end))
    requestAnimationFrame(() => textarea.current?.setSelectionRange(start + text.length, start + text.length))
  }

  /** 把佔位文字換掉；佔位文字已被使用者刪掉時回傳 false */
  function replacePlaceholder(placeholder: string, replacement: string): boolean {
    if (!latest.current.includes(placeholder)) return false
    handleChange(latest.current.replace(placeholder, () => replacement))
    return true
  }

  /** 壓縮 → 上傳 → 把佔位文字換成 ![](img:<id>)，並顯示壓縮前後大小 */
  async function insertImages(files: File[]) {
    for (const file of files) {
      const placeholder = `![上傳中…](uploading:${crypto.randomUUID()})`
      insertAtCursor(placeholder)
      setImageStatus({ kind: 'busy', text: `壓縮圖片中（原始 ${formatBytes(file.size)}）…` })
      try {
        const image = await compressImage(file)
        setImageStatus({ kind: 'busy', text: `上傳中（${formatBytes(image.blob.size)}）…` })
        const id = await repo.uploadImage(image.blob)
        const reduced = Math.round((1 - image.blob.size / image.originalBytes) * 100)
        const sizes =
          `原始 ${formatBytes(image.originalBytes)} → 壓縮後 ${formatBytes(image.blob.size)}` +
          `（${FORMAT_LABEL[image.format]}，${reduced > 0 ? `減少 ${reduced}%` : '沒有變小'}）`
        setImageStatus(
          replacePlaceholder(placeholder, `![](img:${id})`)
            ? { kind: 'done', text: `已插入圖片：${sizes}` }
            : { kind: 'error', text: `圖片已上傳，但插入位置的文字已被刪除，所以沒有插入。${sizes}` },
        )
      } catch (err) {
        replacePlaceholder(placeholder, '')
        setImageStatus({
          kind: 'error',
          text: err instanceof ImageError || err instanceof RepoError ? err.message : '插入圖片失敗，請再試一次。',
        })
      }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    // 沒有圖片，或同時有文字（例如從網頁複製一段圖文）時，照一般貼上處理
    if (images.length === 0 || event.clipboardData.getData('text/plain')) return
    event.preventDefault()
    void insertImages(images)
  }

  // 輸入時先讓編輯框更新，預覽稍後跟上，長筆記也不會卡
  const deferred = useDeferredValue(content ?? '')
  const imageUrls = useImageUrls(deferred)
  const previewHtml = useMemo(() => renderMarkdown(deferred, (id) => imageUrls[id]), [deferred, imageUrls])

  if (loadError) return <p className="message error">{loadError}</p>
  if (content === null) return <p className="detail-placeholder">載入中…</p>

  return (
    <div className="editor" data-view={view}>
      <div className="editor-bar">
        <div className="view-tabs" role="group" aria-label="顯示">
          <button
            type="button"
            className="secondary"
            aria-pressed={view === 'edit'}
            onClick={() => setView('edit')}
          >
            編輯
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={view === 'preview'}
            onClick={() => setView('preview')}
          >
            預覽
          </button>
        </div>
        <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
          插入圖片
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void insertImages(files)
          }}
        />
        <span className={`save-state ${saveState}`} role="status">
          {SAVE_LABEL[saveState]}
        </span>
        {saveState === 'error' && (
          <button type="button" className="secondary" onClick={() => void save()}>
            重試
          </button>
        )}
      </div>
      {saveError && saveState === 'error' && (
        <p className="message error" role="alert">
          {saveError}
        </p>
      )}
      {imageStatus && (
        <p className={`image-status ${imageStatus.kind}`} role="status">
          {imageStatus.text}
        </p>
      )}

      <div className="editor-panes">
        <textarea
          ref={textarea}
          className="editor-input"
          aria-label="Markdown 內容"
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={() => void save()}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Ctrl+S / Cmd+S 立即儲存，不跳出瀏覽器的另存新檔
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault()
              void save()
            }
          }}
          placeholder={'# 標題\n\n開始寫 Markdown…'}
          spellCheck={false}
        />
        {/* previewHtml 已經過 markdown-it（html: false）與 DOMPurify 過濾，見 src/lib/markdown.ts */}
        <article className="markdown" aria-label="預覽" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      </div>
    </div>
  )
}
