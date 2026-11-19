import type { ReadonlyPresetValue, WorkbenchLayout, WorkbenchNode } from '../../../plugin-api/ui/workbench-presets'
type Layout = ReadonlyPresetValue<WorkbenchLayout>

function GlyphNode({ node, primary }: { node: WorkbenchNode; primary: string }) {
  if (node.type === 'group') {
    return <span className={`preset-glyph-pane${node.id === primary ? ' is-primary' : ''}`} />
  }
  return (
    <span className="preset-glyph-split" data-direction={node.direction}>
      <span style={{ flex: `${node.ratio} 1 0%` }}>
        <GlyphNode node={node.first} primary={primary} />
      </span>
      <span style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <GlyphNode node={node.second} primary={primary} />
      </span>
    </span>
  )
}

export function PresetMiniGlyph({ layout, size = 'sm' }: { layout: Layout; size?: 'sm' | 'md' }) {
  return (
    <span className={`preset-mini-glyph is-${size}`} aria-hidden="true">
      {layout.panels.sidebar && <span className="preset-glyph-side" />}
      <span className="preset-glyph-center">
        <GlyphNode node={layout.root} primary={layout.primary} />
      </span>
      {layout.panels.inspector && <span className="preset-glyph-side" />}
    </span>
  )
}

