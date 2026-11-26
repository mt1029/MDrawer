import { useEffect, useState, type ReactNode } from 'react'
import { markdownLinkTarget } from '../lib/imagePaths.ts'
import { RepoError, repo } from '../lib/repo.ts'
import { strings } from '../strings.ts'

interface Props {
  nodeId: string
  /** 圖片的名稱（說明怎麼在筆記裡引用） */
  name: string
  /** 可以連到雲端：圖片只存在雲端，離線時無法顯示 */
  cloud: boolean
  /** 畫出標題區（路徑與名稱） */
  renderHeader: () => ReactNode
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'message'; text: string; error?: boolean }

/** 在檔案總管選了圖片時，右側顯示的預覽與大小 */
export default function ImageViewer({ nodeId, name, cloud, renderHeader }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    if (!cloud) return
    let cancelled = false
    repo
      .getNode(nodeId)
      .then(async (node) => {
        const fileId = node?.content
        if (!fileId) return { kind: 'message', text: strings.images.missing, error: true } as const
        const url = (await repo.getImageUrls([fileId]))[fileId]
        return url ? ({ kind: 'ready', url } as const) : ({ kind: 'message', text: strings.images.missing, error: true } as const)
      })
      .catch((err: unknown) => ({
        kind: 'message' as const,
        text: err instanceof RepoError ? err.message : strings.common.unexpectedReload,
        error: true,
      }))
      .then((next) => {
        if (!cancelled) setState(next)
      })
    return () => {
      cancelled = true
    }
  }, [nodeId, cloud])

  const shown: State = cloud ? state : { kind: 'message', text: strings.images.offline }

  return (
    <>
      {renderHeader()}
      {shown.kind === 'loading' && <p className="detail-placeholder">{strings.images.loading}</p>}
      {shown.kind === 'message' && (
        <p className={shown.error ? 'message error' : 'detail-placeholder'} role={shown.error ? 'alert' : undefined}>
          {shown.text}
        </p>
      )}
      {shown.kind === 'ready' && (
        <figure className="image-viewer">
          <img
            src={shown.url}
            alt={strings.images.previewLabel}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setState({ kind: 'message', text: strings.images.missing, error: true })}
          />
          {size && <figcaption>{strings.images.dimensions(size.width, size.height)}</figcaption>}
        </figure>
      )}
      <p className="image-usage">{strings.images.usage(markdownLinkTarget(name))}</p>
    </>
  )
}
