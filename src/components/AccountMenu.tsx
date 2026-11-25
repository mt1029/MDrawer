import { IconFileZip, IconLogout } from '@tabler/icons-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import ContextMenu, { type MenuRequest } from './ContextMenu.tsx'
import { Icon } from './icons.tsx'

interface Props {
  email: string
  /** 可以匯出（連線、已登入、本機已有資料）；不能時選項變灰，並說明原因 */
  canExport: boolean
  onExport: () => void
  onSignOut: () => void
  signingOut: boolean
}

/**
 * 帳號（spec 第 3 節介面改版第 5 步）：上方列只有一個圓形頭像（email 的第一個字），
 * 點開才看到 email、匯出、登出。之後的設定也放在這裡。
 * 鍵盤：Enter、空白鍵或下鍵打開，選單裡用上下鍵移動，Esc 關閉後焦點回到頭像
 */
export default function AccountMenu({ email, canExport, onExport, onSignOut, signingOut }: Props) {
  const button = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const initial = email.trim().charAt(0).toUpperCase() || '?'

  function open() {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    setMenu({
      x: rect.right,
      y: rect.bottom + 6,
      align: 'end',
      anchor: button.current,
      label: '帳號',
      header: (
        <>
          <span className="menu-header-label">登入帳號</span>
          <span className="menu-header-email">{email}</span>
        </>
      ),
      items: [
        {
          label: canExport ? '匯出 ZIP' : '匯出 ZIP（離線時無法匯出）',
          icon: <Icon of={IconFileZip} />,
          disabled: !canExport,
          onSelect: onExport,
        },
        'separator',
        { label: signingOut ? '登出中…' : '登出', icon: <Icon of={IconLogout} />, disabled: signingOut, onSelect: onSignOut },
      ],
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // 選單按鈕的慣例：下鍵也能打開
    if (event.key === 'ArrowDown' && !menu) {
      event.preventDefault()
      open()
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="avatar"
        aria-label={`帳號選單（${email}）`}
        title={email}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => (menu ? setMenu(null) : open())}
        onKeyDown={handleKeyDown}
      >
        <span aria-hidden="true">{initial}</span>
      </button>
      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
