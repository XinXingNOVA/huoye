import type { UiPlugin, ViewProps } from '../../plugin-api/ui/contracts'
import { viewerTabType } from './viewer'

function ImageSection({ view }: ViewProps) {
  const img = view.blocks.image.data
  return (
    <dl className="props">
      <dt>尺寸</dt>
      <dd>
        {String(img.width)} × {String(img.height)}
      </dd>
      {img.animated ? (
        <>
          <dt>动图</dt>
          <dd>是</dd>
        </>
      ) : null}
    </dl>
  )
}

/** 嵌在文字里的图片：原图按页面宽度显示，点一下在查看器里打开。 */
function ImageEmbed({ view, host }: ViewProps) {
  const f = view.blocks.file
  return <img className="embed-img" src={host.url(String(f.data.path), f.seq)} draggable={false} alt="" title="在查看器中打开" onClick={() => host.open(view.id)} />
}

function ImagePreview({ view, host }: ViewProps) {
  const f = view.blocks.file
  return <img className="preview-img" src={host.url(String(f.data.path), f.seq)} draggable={false} alt="" />
}

export const imageUi: UiPlugin = {
  id: 'image',
  views: [{ id: 'images', title: '图片', query: { has: ['image'] }, defaultVisible: false, order: 10 }],
  previews: [{ priority: 10, match: (v) => !!v.blocks.image && !!v.blocks.file, Component: ImagePreview }],
  embeds: [{ priority: 10, match: (v) => !!v.blocks.image && !!v.blocks.file, Component: ImageEmbed }],
  tabTypes: [viewerTabType],
  // 双击图片：在查看器标签页里打开，带上打开它的列表；空格仍是浮层预览
  // focus 显式清掉：直接打开图片时不再定位到上次的局部
  opens: [{ id: 'image.viewer', title: '图片查看器', priority: 10, match: (v) => !!v.blocks.image && !!v.blocks.file, tab: 'image.viewer', params: (v, from) => ({ id: v.id, list: from, focus: undefined }) }],
  sections: [{ id: 'image', title: '图片', order: 20, kinds: ['image'], Component: ImageSection }]
}

export { imageUi as plugin }
