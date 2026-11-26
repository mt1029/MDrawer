import { IconEye, IconLayoutColumns, IconLayoutRows, IconPencil, IconPhotoPlus } from '@tabler/icons-react'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react'
import { NODE_DRAG_TYPE } from '../lib/dnd.ts'
import { ImageError, compressImage, formatBytes } from '../lib/image.ts'
import { createPathIndex, markdownLinkTarget, relativeImagePath } from '../lib/imagePaths.ts'
import { lineAt } from '../lib/lines.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import { RepoError, imageFileName, mirror, repo, type NodeMeta } from '../lib/repo.ts'
import { useContextMenuTrigger } from '../lib/useContextMenuTrigger.ts'
import { useImageUrls } from '../lib/useImageUrls.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { strings } from '../strings.ts'
import ContextMenu, { type MenuRequest } from './ContextMenu.tsx'
import EditorInput from './EditorInput.tsx'
import { Icon, IconButton } from './icons.tsx'

// 停止輸入多久後自動儲存
const AUTOSAVE_DELAY_MS = 1000

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
/** 顯示方式：只有編輯區、只有預覽、並排（大螢幕左右、小螢幕上下） */
type View = 'edit' | 'preview' | 'split'
type ImageStatus = { kind: 'busy' | 'done' | 'error'; text: string }

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

const SAVE_LABEL: Record<SaveState, string> = strings.editor.saveState

/** 從搜尋結果打開時要捲到、選取的位置；key 每次不同，同一篇再點一次也會執行 */
export interface Reveal {
  offset: number
  length: number
  key: number
}

interface Props {
  noteId: string
  /** 可以連到雲端（連線且已登入）：才能插入、顯示圖片。文字隨時都能編輯，先存在這台裝置 */
  cloud: boolean
  /** 儲存後回傳最新的資料 */
  onSaved: (node: NodeMeta) => void
  /** 畫出標題區；傳進去的內容（儲存狀態、圖示）放在名稱的同一行 */
  renderHeader: (inline?: ReactNode) => ReactNode
  reveal?: Reveal
  /** 筆記所在的資料夾（null 為最上層）：插入的圖片放在這裡，預覽的相對路徑也從這裡算起 */
  folderId: string | null
  /** 資料有變時改變：預覽重新找資料夾裡的圖片 */
  version: number
  /** 在 parentId 資料夾建立了圖片（檔案總管要重新讀取） */
  onImageCreated?: (parentId: string | null) => void
}

/** 貼上的截圖的名稱用的時間：年月日-時分秒 */
function timeStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 拖曳的東西是不是檔案總管的項目或電腦裡的檔案（這兩種由編輯區處理，其他照瀏覽器原本的行為） */
const handlesDrag = (types: readonly string[]) => types.includes(NODE_DRAG_TYPE) || types.includes('Files')

/**
 * 筆記編輯器（spec 第 3 節介面改版第 3 步）：預設只有編輯區，右上角的眼睛切換成預覽；
 * 在眼睛上按右鍵或長按可以改成並排。停止輸入一秒後自動儲存到這台裝置，再在背景同步。
 * 儲存狀態與圖示放在標題同一行，不另外佔一行
 */
export default function NoteEditor({
  noteId,
  cloud,
  onSaved,
  renderHeader,
  reveal,
  folderId,
  version,
  onImageCreated,
}: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [split, setSplit] = useState(loadSplit)
  const [previewOnly, setPreviewOnly] = useState(false)
  const view: View = split ? 'split' : previewOnly ? 'preview' : 'edit'
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const narrow = useMediaQuery('(max-width: 720px)')
  // 有滑鼠的裝置：從搜尋結果打開時選取符合的文字（觸控裝置不選，免得跳出鍵盤）
  const hasMouse = useMediaQuery('(hover: hover) and (pointer: fine)')
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
          setLoadError(strings.editor.notFound)
          return
        }
        latest.current = lastSaved.current = node.content ?? ''
        setContent(latest.current)
      })
      .catch((err: unknown) => {
        if (mounted.current) setLoadError(err instanceof RepoError ? err.message : strings.editor.loadFailed)
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
            setSaveError(err instanceof RepoError ? err.message : strings.editor.saveUnexpected)
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
              setLoadError(strings.editor.deletedElsewhere)
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

  // 從搜尋結果打開：只看預覽時先換回編輯區（在 render 時就調整，不用等 effect 再畫一次）
  const [revealKey, setRevealKey] = useState<number | null>(null)
  if (reveal && reveal.key !== revealKey) {
    setRevealKey(reveal.key)
    setPreviewOnly(false)
  }
  // 捲到符合的那一行；有滑鼠的裝置再選取符合的文字。每個 key 只做一次（打字時內容改變不會再捲）
  const revealed = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal || content === null || revealed.current === reveal.key) return
    const input = textarea.current
    if (!input) return
    revealed.current = reveal.key
    const start = Math.min(reveal.offset, input.value.length)
    const end = Math.min(start + reveal.length, input.value.length)
    const row = input.closest('.code-editor')?.querySelectorAll('.code-line')[lineAt(input.value, start)]
    row?.scrollIntoView({ block: 'center' })
    if (hasMouse) {
      input.focus({ preventScroll: true })
      input.setSelectionRange(start, end)
    }
  }, [reveal, content, hasMouse])

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

  /**
   * 壓縮 → 上傳 → 放進筆記所在的資料夾（撞名時自動加編號）→ 把佔位文字換成 ![](名稱)。
   * 貼上的截圖用時間當名稱（截圖-20261126-153012.webp），拖進來或選的檔案用原本的檔名
   */
  async function insertImages(files: File[], { pasted = false } = {}): Promise<boolean> {
    let allInserted = true
    for (const file of files) {
      const placeholder = `![${strings.editor.image.uploadingPlaceholder}](uploading:${crypto.randomUUID()})`
      insertAtCursor(placeholder)
      setImageStatus({ kind: 'busy', text: strings.editor.image.compressing(formatBytes(file.size)) })
      try {
        const image = await compressImage(file)
        setImageStatus({ kind: 'busy', text: strings.editor.image.uploading(formatBytes(image.blob.size)) })
        const fileId = await repo.uploadImage(image.blob)
        const name = imageFileName(pasted ? strings.editor.image.pastedName(timeStamp(new Date())) : file.name, image.format)
        const node = await repo.createNode({ parentId: folderId, type: 'image', name, content: fileId, rename: true })
        onImageCreated?.(folderId)
        const inserted = replacePlaceholder(placeholder, `![](${markdownLinkTarget(node.name)})`)
        if (!inserted) allInserted = false
        setImageStatus(
          inserted
            ? { kind: 'done', text: strings.editor.image.inserted }
            : { kind: 'error', text: strings.editor.image.placeholderRemoved },
        )
      } catch (err) {
        allInserted = false
        replacePlaceholder(placeholder, '')
        setImageStatus({
          kind: 'error',
          text: err instanceof ImageError || err instanceof RepoError ? err.message : strings.editor.image.failed,
        })
      }
    }
    return allInserted
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    // 沒有圖片，或同時有文字（例如從網頁複製一段圖文）時，照一般貼上處理
    if (images.length === 0 || event.clipboardData.getData('text/plain')) return
    event.preventDefault()
    // 圖片要上傳到雲端，離線時無法插入（spec：離線貼圖列在加分層）
    if (!cloud) {
      setImageStatus({ kind: 'error', text: strings.editor.image.offlinePaste })
      return
    }
    void insertImages(images, { pasted: true })
  }

  /** 把檔案總管的圖片拖進來：插入從這篇筆記到那張圖片的相對路徑 */
  async function insertImageLink(nodeId: string) {
    try {
      const nodes = await repo.listAll()
      const index = createPathIndex(nodes)
      const target = index.byId.get(nodeId)
      if (target?.type !== 'image') return
      insertAtCursor(`![](${markdownLinkTarget(relativeImagePath(index, folderId, target))})`)
    } catch (err) {
      setImageStatus({ kind: 'error', text: err instanceof RepoError ? err.message : strings.editor.image.failed })
    }
  }

  /** 拖進編輯區：檔案總管的圖片插入連結；電腦裡的圖片上傳到這個資料夾再插入（插在游標的位置） */
  function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
    if (!handlesDrag(event.dataTransfer.types)) return
    event.preventDefault()
    textarea.current?.focus()
    const nodeId = event.dataTransfer.getData(NODE_DRAG_TYPE)
    if (nodeId) {
      void insertImageLink(nodeId)
      return
    }
    const files = Array.from(event.dataTransfer.files)
    const images = files.filter((file) => file.type.startsWith('image/'))
    const skipped = files.length - images.length
    if (images.length === 0) {
      setImageStatus({ kind: 'error', text: strings.editor.image.notImage })
      return
    }
    if (!cloud) {
      setImageStatus({ kind: 'error', text: strings.editor.image.offlinePaste })
      return
    }
    // 圖片插入完才說有幾個檔案沒插入，不然訊息會被插入的進度蓋掉
    void insertImages(images).then((inserted) => {
      if (inserted && skipped > 0) setImageStatus({ kind: 'error', text: strings.editor.image.skippedFiles(skipped) })
    })
  }

  /** 切換顯示方式。回到只有編輯區時，游標放回編輯框 */
  function changeView(next: View) {
    setSplit(next === 'split')
    saveSplit(next === 'split')
    setPreviewOnly(next === 'preview')
    if (next === 'edit') requestAnimationFrame(() => textarea.current?.focus())
  }

  const splitLabel = narrow ? strings.editor.view.splitRows : strings.editor.view.splitColumns
  const menuTrigger = useContextMenuTrigger((_target: null, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: strings.editor.view.label,
      items: [
        {
          label: strings.editor.view.editOnly,
          icon: <Icon of={IconPencil} />,
          checked: view === 'edit',
          onSelect: () => changeView('edit'),
        },
        {
          label: strings.editor.view.previewOnly,
          icon: <Icon of={IconEye} />,
          checked: view === 'preview',
          onSelect: () => changeView('preview'),
        },
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
  const resolveImage = useImageUrls(deferred, { folderId, version, active: showPreview, online: cloud })
  const previewHtml = useMemo(
    () => (showPreview ? renderMarkdown(deferred, { offline: !cloud, resolveImage }) : ''),
    [deferred, resolveImage, cloud, showPreview],
  )
  const eyeLabel = view === 'edit' ? strings.editor.preview : strings.editor.backToEdit

  if (loadError) {
    return (
      <>
        {renderHeader()}
        <p className="message error">{loadError}</p>
      </>
    )
  }
  if (content === null) {
    return (
      <>
        {renderHeader()}
        <p className="detail-placeholder">{strings.common.loading}</p>
      </>
    )
  }

  // 放在標題同一行：名稱後面是儲存狀態，最右邊是插入圖片、預覽。名稱太長時這些換到下一行
  const inline = (
    <>
      <span className={`save-state ${saveState}`} role="status">
        {SAVE_LABEL[saveState]}
      </span>
      {saveState === 'error' && (
        <button type="button" className="link-button" onClick={() => void save()}>
          {strings.common.retry}
        </button>
      )}
      <div className="editor-actions">
        <IconButton
          icon={IconPhotoPlus}
          label={cloud ? strings.editor.insertImage : strings.editor.insertImageOffline}
          disabled={!cloud}
          onClick={() => fileInput.current?.click()}
        />
        <IconButton
          icon={IconEye}
          label={eyeLabel}
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
    </>
  )

  return (
    <>
      {renderHeader(inline)}
      <div className="editor" data-view={view}>
        {saveError && saveState === 'error' && (
          <p className="message error" role="alert">
            {saveError}
          </p>
        )}
        {notice && (
          <p className="message warning" role="status">
            {notice}{' '}
            <button type="button" className="link-button" onClick={() => setNotice(null)}>
              {strings.common.gotIt}
            </button>
          </p>
        )}
        {imageStatus && (
          <p className={`image-status ${imageStatus.kind}`} role="status">
            {imageStatus.text}
          </p>
        )}

        <div className="editor-panes">
          <EditorInput
            ref={textarea}
            aria-label={strings.editor.inputLabel}
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => void save()}
            onPaste={handlePaste}
            onDragOver={(e) => {
              // 檔案總管的項目、電腦裡的檔案：允許放下（不然瀏覽器會打開檔案）
              if (!handlesDrag(e.dataTransfer.types)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={handleDrop}
            onKeyDown={(e) => {
              // Ctrl+S / Cmd+S 立即儲存，不跳出瀏覽器的另存新檔
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void save()
              }
            }}
            placeholder={strings.editor.placeholder}
            spellCheck={false}
          />
          {/* previewHtml 已經過 markdown-it（html: false）與 DOMPurify 過濾，見 src/lib/markdown.ts */}
          <article className="markdown" aria-label={strings.editor.previewLabel} dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
        {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
      </div>
    </>
  )
}
