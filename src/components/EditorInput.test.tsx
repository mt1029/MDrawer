// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import EditorInput, { lineAt } from './EditorInput.tsx'

// 讓 React 知道這是測試環境，act() 會等畫面更新完
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('lineAt', () => {
  it('回傳 offset 所在的行（從 0 起算）', () => {
    const text = 'ab\ncd\n\nef'
    expect(lineAt(text, 0)).toBe(0)
    expect(lineAt(text, 2)).toBe(0) // 第一行的行尾（換行之前）
    expect(lineAt(text, 3)).toBe(1)
    expect(lineAt(text, 6)).toBe(2) // 空行
    expect(lineAt(text, text.length)).toBe(3)
    expect(lineAt('', 0)).toBe(0)
  })
})

describe('EditorInput', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  /** 跟 NoteEditor 一樣用 state 控制內容 */
  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial)
    return <EditorInput aria-label="內容" value={value} onChange={(event) => setValue(event.target.value)} />
  }

  const textarea = () => container.querySelector('textarea')!
  const rows = () => [...container.querySelectorAll('.code-line')]
  const numbers = () => rows().map((row) => row.querySelector('.code-number')!.textContent)
  const marked = (state: 'current' | 'active') =>
    container.querySelector(`.code-line.${state} .code-number`)?.textContent ?? null

  /** 像使用者打字一樣改內容並觸發 input 事件 */
  function type(value: string, caret = value.length) {
    act(() => {
      const el = textarea()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
      el.setSelectionRange(caret, caret)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** 移動游標或選取文字。React 的 onSelect 是從 selectionchange（以及 keyup、mouseup）組出來的，不是原生的 select 事件 */
  function select(start: number, end = start, direction: 'forward' | 'backward' = 'forward') {
    act(() => {
      textarea().setSelectionRange(start, end, direction)
      document.dispatchEvent(new Event('selectionchange'))
    })
  }

  it('每一行一個行號，空行與結尾的換行也算一行', () => {
    act(() => root.render(<Harness initial={'# 標題\n\n內文\n'} />))
    expect(numbers()).toEqual(['1', '2', '3', '4'])
    const texts = rows().map((row) => row.querySelector('.code-text')!.getAttribute('data-text'))
    // 空行放零寬空格，才會有一行的高度
    expect(texts).toEqual(['# 標題', '​', '內文', '​'])
    // 後面那一層不給螢幕閱讀器，也不是真的文字（data-text 用 CSS 顯示，不會被「尋找」找到）
    expect(container.querySelector('.code-lines')!.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.code-text')!.textContent).toBe('')
  })

  it('\\r\\n 與 \\n 一樣算一個換行', () => {
    act(() => root.render(<Harness initial={'a\r\nb'} />))
    expect(numbers()).toEqual(['1', '2'])
  })

  it('行號欄最少兩位數，超過 99 行才加寬', () => {
    act(() => root.render(<Harness initial={'x\n'.repeat(98)} />))
    expect(rows()).toHaveLength(99)
    expect(container.querySelector<HTMLElement>('.code-editor')!.style.getPropertyValue('--digits')).toBe('2')
    type('x\n'.repeat(99))
    expect(rows()).toHaveLength(100)
    expect(container.querySelector<HTMLElement>('.code-editor')!.style.getPropertyValue('--digits')).toBe('3')
  })

  it('有焦點時標示游標所在的行，失去焦點就不標示', () => {
    act(() => root.render(<Harness initial={'aa\nbb\ncc'} />))
    expect(marked('current')).toBeNull()

    act(() => textarea().focus())
    select(4) // 第二行
    expect(marked('current')).toBe('2')

    select(7) // 第三行
    expect(marked('current')).toBe('3')

    act(() => textarea().blur())
    expect(marked('current')).toBeNull()
  })

  it('打字換行時，標示跟著游標到新的一行', () => {
    act(() => root.render(<Harness initial={'aa'} />))
    act(() => textarea().focus())
    type('aa\n')
    expect(numbers()).toEqual(['1', '2'])
    expect(marked('current')).toBe('2')
  })

  it('選取一段文字時不標示整行，只把游標那一端所在行的行號變亮', () => {
    act(() => root.render(<Harness initial={'aa\nbb\ncc'} />))
    act(() => textarea().focus())
    select(1, 7) // 從第一行選到第三行，游標在第三行
    expect(marked('current')).toBeNull()
    expect(marked('active')).toBe('3')

    // 往回選（從第三行往上選到第一行），游標在第一行
    select(7)
    select(1, 7, 'backward')
    expect(marked('current')).toBeNull()
    expect(marked('active')).toBe('1')
  })

  it('沒有焦點時，程式改了內容也不標示', () => {
    act(() => root.render(<Harness initial={'aa'} />))
    type('aa\nbb')
    expect(marked('current')).toBeNull()
  })
})
