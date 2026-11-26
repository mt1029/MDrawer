import {
  memo,
  useCallback,
  useState,
  type CSSProperties,
  type Dispatch,
  type Ref,
  type SetStateAction,
  type TextareaHTMLAttributes,
} from 'react'
import { lineAt } from '../lib/lines.ts'

/** 行號欄最少留兩位數的寬度，行數變多時才加寬，打字時不會一直跳 */
const MIN_DIGITS = 2

type LineState = 'current' | 'active' | null

/** 游標所在的行與有沒有選取文字；沒有焦點時為 null */
type Caret = { line: number; collapsed: boolean } | null

/** 依 textarea 目前的選取範圍更新游標所在的行 */
function trackCaret(textarea: HTMLTextAreaElement, setCaret: Dispatch<SetStateAction<Caret>>) {
  // 沒有焦點時沒有游標，不標示（例如程式改了內容）
  if (textarea !== document.activeElement) return
  // 游標在選取範圍的哪一端：往回選時在開頭
  const end = textarea.selectionDirection === 'backward' ? textarea.selectionStart : textarea.selectionEnd
  const line = lineAt(textarea.value, end)
  const collapsed = textarea.selectionStart === textarea.selectionEnd
  setCaret((prev) => (prev && prev.line === line && prev.collapsed === collapsed ? prev : { line, collapsed }))
}

/** 把元素交給外面傳進來的 ref（函式或物件都可以） */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

/**
 * 背景的一行：左邊是行號，右邊是跟編輯框一樣的文字（透明），讓這一行的高度跟編輯框裡自動換行後的高度一樣。
 * 文字用 CSS 的 content（attr(data-text)）畫出來，不是真的文字，瀏覽器的「尋找」不會在這裡多找到一次。
 * attr() 只會當成純文字顯示，不會被解析成 HTML，筆記內容放在這裡沒有 XSS 的問題
 */
const Line = memo(function Line({ number, text, state }: { number: number; text: string; state: LineState }) {
  return (
    <div className={state ? `code-line ${state}` : 'code-line'}>
      <span className="code-number">{number}</span>
      {/* 空行放一個零寬空格，才會有一行的高度 */}
      <span className="code-text" data-text={text || '​'} />
    </div>
  )
})

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'className'> & {
  value: string
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * 有行號、游標所在行會標示的 Markdown 編輯框（類似 VS Code）。
 *
 * 編輯的仍是原本的 textarea（輸入法、手機鍵盤、復原都照瀏覽器原本的行為），
 * 後面墊一層同樣字型、同樣寬度的「每一行」：行號放在每一行的第一列，很長的行自動換行時也對得上。
 * textarea 的高度跟著內容長，與後面那一層在同一個捲動框裡一起捲動，行號不會慢一拍
 */
export default function EditorInput({ value, ref, onChange, onFocus, onBlur, onSelect, ...rest }: Props) {
  // 游標所在的行；沒有焦點時為 null（不標示）。選取一段文字時不標示整行，只把行號變亮（跟 VS Code 一樣）
  const [caret, setCaret] = useState<Caret>(null)
  const track = (textarea: HTMLTextAreaElement) => trackCaret(textarea, setCaret)

  // 程式改選取範圍（例如從搜尋結果打開時選取符合的字、插入圖片後移動游標）不會觸發 React 的 onSelect，
  // 另外聽 textarea 原生的 select 與 selectionchange 事件
  const attach = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      assignRef(ref, textarea)
      if (!textarea) return
      const update = () => trackCaret(textarea, setCaret)
      textarea.addEventListener('select', update)
      textarea.addEventListener('selectionchange', update)
      return () => {
        textarea.removeEventListener('select', update)
        textarea.removeEventListener('selectionchange', update)
        assignRef(ref, null)
      }
    },
    [ref],
  )

  // textarea 會把 \r\n 當成一個換行，這裡也一樣
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const digits = Math.max(MIN_DIGITS, String(lines.length).length)

  return (
    <div className="code-editor" style={{ '--digits': digits } as CSSProperties}>
      <div className="code-lines" aria-hidden="true">
        {lines.map((text, index) => (
          <Line
            key={index}
            number={index + 1}
            text={text}
            state={caret?.line === index ? (caret.collapsed ? 'current' : 'active') : null}
          />
        ))}
      </div>
      <textarea
        ref={attach}
        className="code-input"
        value={value}
        {...rest}
        onChange={(event) => {
          // 跟內容一起更新，按 Enter 時標示不會慢一拍停在上一行
          track(event.currentTarget)
          onChange?.(event)
        }}
        onSelect={(event) => {
          track(event.currentTarget)
          onSelect?.(event)
        }}
        onFocus={(event) => {
          track(event.currentTarget)
          onFocus?.(event)
        }}
        onBlur={(event) => {
          setCaret(null)
          onBlur?.(event)
        }}
      />
    </div>
  )
}
