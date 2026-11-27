import { useEffect, useState, type ReactNode } from 'react'
import { markdownLinkTarget } from '../lib/imagePaths.ts'
import { RepoError, repo } from '../lib/repo.ts'
import { strings } from '../strings.ts'

interface Props {
  nodeId: string
  /** 圖片的名稱（說明怎麼在筆記裡引用） */
  name: string
  /** 可以連到雲端：雲端上的圖片離線時無法顯示（離線時插入、還沒上傳的可以）。恢復連線時重新讀取 */
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
    let cancelled = false
    repo
      .getNode(nodeId)
      .then(async (node): Promise<State> => {
        const fileId = node?.content
        if (!fileId) return { kind: 'message', text: strings.images.missing, error: true }
        const url = (await repo.getImageUrls([fileId]))[fileId]
        if (url) return { kind: 'ready', url }
        // 沒有列出：離線，而且這張在雲端
        if (url === undefined) return { kind: 'message', text: strings.images.offline }
        return { kind: 'message', text: strings.images.missing, error: true }
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

  return (
    <>
      {renderHeader()}
      {state.kind === 'loading' && <p className="detail-placeholder">{strings.images.loading}</p>}
      {state.kind === 'message' && (
        <p className={state.error ? 'message error' : 'detail-placeholder'} role={state.error ? 'alert' : undefined}>
          {state.text}
        </p>
      )}
      {state.kind === 'ready' && (
        <figure className="image-viewer">
          <img
            src={state.url}
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
