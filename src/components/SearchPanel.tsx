import { IconFiles } from '@tabler/icons-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { repo } from '../lib/repo.ts'
import {
  abbreviatePath,
  folderDepth,
  searchNotes,
  type LineHit,
  type SearchOutcome,
  type SearchResult,
  type TextPart,
} from '../lib/search.ts'
import { strings } from '../strings.ts'
import { IconButton, NoteIcon } from './icons.tsx'

// 停止輸入多久後才搜尋（毫秒）：打字時不會每個字都讀一次全部資料
const DEBOUNCE_MS = 150

interface Props {
  query: string
  onQueryChange: (query: string) => void
  /** 資料有變（新增、改名、儲存、同步）時改變，結果跟著更新 */
  version: number
  /** 小螢幕沒有左側圖示欄：標題列放一個回到檔案總管的圖示 */
  narrow: boolean
  onShowExplorer: () => void
  /** 打開筆記；hit 是點的那一行（點筆記名稱時沒有） */
  onOpen: (result: SearchResult, hit?: LineHit) => void
  inputRef?: Ref<HTMLInputElement>
}

/** 符合的部分用 <mark> 標出來。文字由 React 放進去，不是 HTML，不會有 XSS 的問題 */
function Highlight({ parts }: { parts: TextPart[] }) {
  return parts.map((part, index) =>
    part.match ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>,
  )
}

const plain = (parts: TextPart[]) => parts.map((part) => part.text).join('')

/**
 * 結果的筆記名稱，前面接所在的資料夾路徑（例如「/課程/第一週/筆記」）。
 * 放不下時從最上層開始一層一層縮短路徑（/o.../t.../final/），全部縮了還放不下才截斷名稱
 */
function NoteLabel({ path, children }: { path: string; children: ReactNode }) {
  const name = useRef<HTMLSpanElement>(null)
  // 目前的寬度與縮短了幾層。寬度改變時層數歸零，從完整的路徑重新量
  // （寬度也放進 state：層數本來就是 0 時，光把層數設成 0 不會重新量）
  const [fit, setFit] = useState({ width: -1, level: 0 })
  const depth = folderDepth(path)

  useLayoutEffect(() => {
    const element = name.current?.parentElement
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      setFit((prev) => (prev.width === width ? prev : { width, level: 0 }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 名稱被截斷就多縮一層再量。在畫面畫出來之前做完，看不到中間的樣子
  useLayoutEffect(() => {
    const element = name.current
    if (element && fit.level < depth && element.scrollWidth > element.clientWidth + 1) {
      setFit({ ...fit, level: fit.level + 1 })
    }
  }, [fit, depth])

  return (
    <span className="search-label">
      <span className="search-path">{abbreviatePath(path, fit.level)}</span>
      <span ref={name} className="search-name">
        {children}
      </span>
    </span>
  )
}

/**
 * 搜尋面板（spec 第 3 節介面改版第 6 步）：搜尋這台裝置上所有筆記的名稱與內容，離線也能用。
 * 結果依筆記分組，列出符合的行；點筆記或某一行就打開，並捲到那一行
 */
export default function SearchPanel({ query, onQueryChange, version, narrow, onShowExplorer, onOpen, inputRef }: Props) {
  // 最近一次搜尋的結果。輸入時先保留上一次的結果，新的算好再換，畫面不會一直閃
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null)
  const [failed, setFailed] = useState(false)
  const text = query.trim()

  useEffect(() => {
    if (!text) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      repo
        .listAll()
        .then((nodes) => {
          if (cancelled) return
          setOutcome(searchNotes(nodes, text))
          setFailed(false)
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [text, version])

  const shown = text ? outcome : null
  const summary =
    shown && shown.noteCount > 0 ? strings.search.summary(shown.noteCount, shown.matchCount) : ''

  return (
    <>
      <header className="panel-header">
        <h2 className="panel-title">{strings.search.title}</h2>
        <div className="panel-actions">
          {narrow && <IconButton icon={IconFiles} label={strings.workspace.explorer} onClick={onShowExplorer} />}
        </div>
      </header>

      <div className="search-box">
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={strings.search.placeholder}
          aria-label={strings.search.inputLabel}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </div>

      <div className="panel-body search-body">
        {/* 一直放著，結果數量改變時螢幕閱讀器才會念出來 */}
        <p className="search-summary" role="status">
          {summary}
        </p>
        {failed ? (
          <p className="message error" role="alert">
            {strings.search.failed}
          </p>
        ) : !text ? (
          <p className="search-hint">{strings.search.hint}</p>
        ) : shown && shown.noteCount === 0 ? (
          <p className="search-hint">{strings.search.noResults(text)}</p>
        ) : (
          shown && (
            <>
              <ul className="search-results">
                {shown.results.map((result) => (
                  <li key={result.note.id}>
                    <button
                      type="button"
                      className="search-note"
                      aria-label={strings.search.noteLabel(result.note.name, result.path, result.count)}
                      title={result.path + result.note.name}
                      onClick={() => onOpen(result)}
                    >
                      <NoteIcon />
                      {/* 路徑改變（例如改名）時重新量 */}
                      <NoteLabel key={result.path} path={result.path}>
                        {result.name ? <Highlight parts={result.name} /> : result.note.name}
                      </NoteLabel>
                      {result.count > 0 && <span className="search-count">{result.count}</span>}
                    </button>
                    {result.lines.length > 0 && (
                      <ul className="search-lines">
                        {result.lines.map((hit) => (
                          <li key={hit.line}>
                            <button
                              type="button"
                              className="search-line"
                              aria-label={strings.search.lineLabel(hit.line, plain(hit.parts))}
                              onClick={() => onOpen(result, hit)}
                            >
                              <span className="search-line-number">{hit.line}</span>
                              <span className="search-line-text">
                                <Highlight parts={hit.parts} />
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {result.hidden > 0 && <p className="search-more">{strings.search.more(result.hidden)}</p>}
                  </li>
                ))}
              </ul>
              {shown.noteCount > shown.results.length && (
                <p className="search-hint">{strings.search.truncated(shown.results.length)}</p>
              )}
            </>
          )
        )}
      </div>
    </>
  )
}
