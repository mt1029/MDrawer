import { IconEye, IconLayoutColumns, IconLayoutRows, IconPencil, IconPhotoPlus } from '@tabler/icons-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { ImageError, compressImage, formatBytes, type ImageFormat } from '../lib/image.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import { RepoError, mirror, repo, type NodeMeta } from '../lib/repo.ts'
import { useContextMenuTrigger } from '../lib/useContextMenuTrigger.ts'
import { useImageUrls } from '../lib/useImageUrls.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import ContextMenu, { type MenuRequest } from './ContextMenu.tsx'
import { Icon, IconButton } from './icons.tsx'

// 停止輸入多久後自動儲存
const AUTOSAVE_DELAY_MS = 1000

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
/** 顯示方式：只有編輯區、只有預覽、並排（大螢幕左右、小螢幕上下） */
type View = 'edit' | 'preview' | 'split'
type ImageStatus = { kind: 'busy' | 'done' | 'error'; text: string }

const FORMAT_LABEL: Record<ImageFormat, string> = { 'image/webp': 'WebP', 'image/jpeg': 'JPEG' }

// 「並排」是版面的選擇，記在這台裝置，下次開別的筆記也一樣；只看預覽是暫時的，每篇都從編輯開始
const SPLIT_KEY = 'mdrawer.editor.split'

function loadSplit(): boolean {
  try {
    return localStorage.getItem(SPLIT_KEY) === '1'
  } catch {
    return false // 無痕模式等不能用 localStorage：每次都從只有編輯區開始
  }
}

function saveSplit(split: boolean) {
  try {
    localStorage.setItem(SPLIT_KEY, split ? '1' : '0')
  } catch {
    // 存不了只影響下次的預設
  }
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已儲存',
  dirty: '尚未儲存',
  saving: '儲存中…',
  error: '儲存失敗',
}

interface Props {
  noteId: string
  /** 可以連到雲端（連線且已登入）：才能插入、顯示圖片。文字隨時都能編輯，先存在這台裝置 */
  cloud: boolean
  /** 儲存後回傳最新的資料 */
  onSaved: (node: NodeMeta) => void
}

/**
 * 筆記編輯器（spec 第 3 節介面改版第 3 步）：預設只有編輯區，右上角的眼睛切換成預覽；
 * 在眼睛上按右鍵或長按可以改成並排。停止輸入一秒後自動儲存到這台裝置，再在背景同步
 */
export default function NoteEditor({ noteId, cloud, onSaved }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [split, setSplit] = useState(loadSplit)
  const [previewOnly, setPreviewOnly] = useState(false)
  const view: View = split ? 'split' : previewOnly ? 'preview' : 'edit'
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const narrow = useMediaQuery('(max-width: 720px)')
  const canHover = useMediaQuery('(hover: hover)')
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null)
  // 衝突時的說明（這次的內容已另存為衝突副本）
  const [notice, setNotice] = useState<string | null>(null)
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
          // baseContent：這次是根據哪個內容改的。編輯期間這篇被同步改過的話，repo 不會蓋掉它
          const node = await repo.updateNode(noteId, { content: text, baseContent: lastSaved.current })
          lastSaved.current = text
          onSavedRef.current(node)
          if (mounted.current) setSaveError(null)
        } catch (err) {
          if (err instanceof RepoError && err.kind === 'conflict') {
            // 這次的內容已另存為衝突副本：編輯器換成同步來的版本，迴圈接著檢查有沒有新打的字
            const node = await repo.getNode(noteId).catch(() => null)
            latest.current = lastSaved.current = node?.content ?? ''
            if (mounted.current) {
              setContent(latest.current)
              setNotice(err.message)
            }
            continue
          }
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

  // 同步拉到其他裝置對這篇的修改時，換成新的內容。
  // 有還沒存的內容就先不換：之後儲存時 repo 會發現內容被改過，把這次的內容另存為衝突副本
  useEffect(
    () =>
      mirror.onChange((ids) => {
        if (!ids.includes(noteId) || latest.current !== lastSaved.current || saving.current) return
        repo
          .getNode(noteId)
          .then((node) => {
            if (!mounted.current || latest.current !== lastSaved.current) return
            if (!node) {
              setLoadError('這篇筆記已經在其他裝置刪除。')
              return
            }
            if ((node.content ?? '') === lastSaved.current) return
            latest.current = lastSaved.current = node.content ?? ''
            setContent(latest.current)
          })
          .catch(() => undefined)
      }),
    [noteId],
  )

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
    // 圖片要上傳到雲端，離線時無法插入（spec：離線貼圖列在加分層）
    if (!cloud) {
      setImageStatus({ kind: 'error', text: '離線時無法插入圖片，恢復連線後再貼一次。' })
      return
    }
    void insertImages(images)
  }

  /** 切換顯示方式。回到只有編輯區時，游標放回編輯框 */
  function changeView(next: View) {
    setSplit(next === 'split')
    saveSplit(next === 'split')
    setPreviewOnly(next === 'preview')
    if (next === 'edit') requestAnimationFrame(() => textarea.current?.focus())
  }

  const splitLabel = narrow ? '並排（上下）' : '並排（左右）'
  const menuTrigger = useContextMenuTrigger((_target: null, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: '顯示方式',
      items: [
        { label: '只顯示編輯區', icon: <Icon of={IconPencil} />, checked: view === 'edit', onSelect: () => changeView('edit') },
        { label: '只顯示預覽', icon: <Icon of={IconEye} />, checked: view === 'preview', onSelect: () => changeView('preview') },
        {
          label: splitLabel,
          icon: <Icon of={narrow ? IconLayoutRows : IconLayoutColumns} />,
          checked: view === 'split',
          onSelect: () => changeView('split'),
        },
      ],
    }),
  )

  // 輸入時先讓編輯框更新，預覽稍後跟上，長筆記也不會卡。看不到預覽時不轉換、不取圖片網址
  const showPreview = view !== 'edit'
  const deferred = useDeferredValue(content ?? '')
  const imageUrls = useImageUrls(deferred, cloud && showPreview)
  const previewHtml = useMemo(
    () => (showPreview ? renderMarkdown(deferred, (id) => imageUrls[id], { offline: !cloud }) : ''),
    [deferred, imageUrls, cloud, showPreview],
  )
  const eyeLabel = view === 'edit' ? '預覽 Markdown' : '回到編輯'

  if (loadError) return <p className="message error">{loadError}</p>
  if (content === null) return <p className="detail-placeholder">載入中…</p>

  return (
    <div className="editor" data-view={view}>
      <div className="editor-bar">
        <span className={`save-state ${saveState}`} role="status">
          {SAVE_LABEL[saveState]}
        </span>
        {saveState === 'error' && (
          <button type="button" className="link-button" onClick={() => void save()}>
            重試
          </button>
        )}
        <div className="editor-actions">
          <IconButton
            icon={IconPhotoPlus}
            label={cloud ? '插入圖片' : '離線時無法插入圖片'}
            disabled={!cloud}
            onClick={() => fileInput.current?.click()}
          />
          <IconButton
            icon={IconEye}
            label={eyeLabel}
            title={`${eyeLabel}（${canHover ? '按右鍵' : '長按'}可以改成並排）`}
            pressed={showPreview}
            {...menuTrigger(null)}
            onClick={() => changeView(view === 'edit' ? 'preview' : 'edit')}
          />
        </div>
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
      </div>
      {saveError && saveState === 'error' && (
        <p className="message error" role="alert">
          {saveError}
        </p>
      )}
      {notice && (
        <p className="message warning" role="status">
          {notice}{' '}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            知道了
          </button>
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
      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
