// 链接的列表：这篇文字提到的、提到它的（反向链接，经由链接块的关联引用，就是一次普通查询）。
// 检查器的分区、文字标签页的页脚共用。

import { useEffect, useState } from 'react'
import { useEntity } from '../../plugin-api/ui/data'
import type { UiHost } from '../../plugin-api/ui/contracts'

/** 提到这个身份的文字（不在回收站里的）。 */
export function useBacklinks(host: UiHost, id: string): string[] {
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () =>
      host.core
        .query({ scope: 'all', where: [{ op: 'eq', kind: 'links', field: 'targets', value: id }] })
        .then((r) => alive && setIds(r.ids.filter((x) => x !== id)))
    run()
    const off = host.core.on('listChanged', () => {
      clearTimeout(timer)
      timer = setTimeout(run, 150)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [host, id])
  return ids
}

/** 一行：缩略图、标题；点一下打开。 */
export function LinkRow({ id, host }: { id: string; host: UiHost }) {
  const view = useEntity(id)
  if (!view) return null
  const thumb = view.blocks.thumb
  return (
    <button className={`local-row link-row${view.deletedAt ? ' trashed' : ''}`} title="打开" onClick={() => host.open(id)}>
      <span className="local-thumb">{thumb ? <img src={host.url(String(thumb.data.path), thumb.seq)} alt="" /> : <span className="link-row-icon">文</span>}</span>
      <span className="local-text">
        <span>{host.title(view)}</span>
        {view.deletedAt ? <span className="muted">在回收站里</span> : null}
      </span>
    </button>
  )
}

export function LinkList({ ids, host }: { ids: string[]; host: UiHost }) {
  return (
    <div className="annotations">
      {ids.map((id) => (
        <LinkRow key={id} id={id} host={host} />
      ))}
    </div>
  )
}

/** 提到它的：没有时什么也不画（检查器里整个分区隐藏）。 */
export function Backlinks({ id, host, title }: { id: string; host: UiHost; title?: string }) {
  const ids = useBacklinks(host, id)
  if (!ids.length) return null
  return (
    <>
      {title && (
        <div className="backlinks-title">
          {title}（{ids.length}）
        </div>
      )}
      <LinkList ids={ids} host={host} />
    </>
  )
}
