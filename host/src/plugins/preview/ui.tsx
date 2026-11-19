import type { UiPlugin, ViewProps } from '../../plugin-api/ui/contracts'

function ThumbCover({ view, host }: ViewProps) {
  const t = view.blocks.thumb
  return (
    <img
      className="cover-img"
      src={host.url(String(t.data.path), t.seq)}
      style={{ background: 'var(--placeholder)' }}
      loading="lazy"
      decoding="async"
      draggable={false}
      alt=""
    />
  )
}

/** 代表图已有、缩略图还没生成：按正确比例占位。 */
function PendingCover() {
  return <div className="cover-pending" />
}

export const previewUi: UiPlugin = {
  id: 'preview',
  covers: [
    { priority: 10, match: (v) => !!v.blocks.thumb, Component: ThumbCover },
    { priority: 20, match: (v) => !!v.blocks.still, Component: PendingCover }
  ],
  icons: [{ priority: 10, get: (v, host) => (v.blocks.thumb ? host.abs(String(v.blocks.thumb.data.path)) : undefined) }]
}

export { previewUi as plugin }
