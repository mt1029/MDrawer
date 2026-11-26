import { IconFileZip, IconLogout, IconMenu2 } from '@tabler/icons-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import ContextMenu, { type MenuRequest } from './ContextMenu.tsx'
import { strings } from '../strings.ts'
import { Icon, IconButton } from './icons.tsx'

interface Props {
  email: string
  /** 可以匯出（連線、已登入、本機已有資料）；不能時選項變灰，並說明原因 */
  canExport: boolean
  onExport: () => void
  onSignOut: () => void
  signingOut: boolean
}

/**
 * 主選單（spec 第 3 節介面改版第 5 步）：上方列右邊只有一個選單圖示（三條橫線），
 * 點開才看到登入的 email、匯出、登出。之後的設定也放在這裡。
 * 鍵盤：Enter、空白鍵或下鍵打開，選單裡用上下鍵移動，Esc 關閉後焦點回到選單圖示
 */
export default function AccountMenu({ email, canExport, onExport, onSignOut, signingOut }: Props) {
  const button = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)

  function open() {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    setMenu({
      x: rect.right,
      y: rect.bottom + 6,
      align: 'end',
      anchor: button.current,
      label: strings.menu.label,
      header: (
        <>
          <span className="menu-header-label">{strings.menu.signedInAs}</span>
          <span className="menu-header-email" title={email}>
            {email}
          </span>
        </>
      ),
      items: [
        {
          label: canExport ? strings.menu.exportZip : strings.menu.exportZipOffline,
          icon: <Icon of={IconFileZip} />,
          disabled: !canExport,
          onSelect: onExport,
        },
        'separator',
        {
          label: signingOut ? strings.menu.signingOut : strings.menu.signOut,
          icon: <Icon of={IconLogout} />,
          disabled: signingOut,
          onSelect: onSignOut,
        },
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
      <IconButton
        ref={button}
        icon={IconMenu2}
        label={strings.menu.label}
        className="icon-button menu-button"
        size={22}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => (menu ? setMenu(null) : open())}
        onKeyDown={handleKeyDown}
      />
      {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
