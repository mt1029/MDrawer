// 樹狀清單用的小圖示，顏色跟著文字顏色

const common = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function FolderIcon() {
  return (
    <svg {...common}>
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function NoteIcon() {
  return (
    <svg {...common}>
      <path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
      <path d="M9.25 1.75v3h3M5.75 8.25h4.5M5.75 10.75h4.5" />
    </svg>
  )
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg {...common} className={open ? 'chevron open' : 'chevron'}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}
