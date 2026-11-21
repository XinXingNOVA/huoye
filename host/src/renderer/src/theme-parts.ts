import type { ThemeParts } from '../../shared/theme-parts'

const pixels = (n?: number) => n === undefined ? undefined : n + 'px'
const color = (name?: NonNullable<ThemeParts['card-cover']>['frameColor']) => name && 'var(--' + (name === 'panel2' ? 'panel-2' : name) + ')'
function rule(part: keyof ThemeParts, properties: Record<string, string | number | undefined>) {
  const declarations = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `--hy-${name}: ${value};`)
  return declarations.length ? `[data-hy-part="${part}"] { ${declarations.join(' ')} }` : ''
}

/** 仅将已校验的声明映射至宿主提供的部位。整张样式表随显示文档同步及卸载。 */
export function applyThemeParts(doc: Document, parts?: ThemeParts) {
  const cover = parts?.['card-cover'], caption = parts?.['card-caption']
  const section = parts?.['inspector-section'], page = parts?.['reader-page']
  doc.documentElement.toggleAttribute('data-hy-overlay-caption', caption?.placement === 'overlay')
  const sheet = doc.getElementById('hy-theme-parts')
  if (!parts) { sheet?.remove(); return }
  const pdfFilters = { original: 'none', warm: 'var(--pdf-warm-filter)', dark: 'var(--pdf-dark-filter)' }
  const rules = [
    rule('card-cover', { 'cover-frame': pixels(cover?.frameWidth), 'cover-edge': color(cover?.frameColor), 'cover-radius': pixels(cover?.radius) }),
    rule('card-caption', { 'caption-align': caption?.align, 'caption-weight': caption?.weight }),
    rule('inspector-section', { 'section-bg': color(section?.background), 'section-radius': pixels(section?.radius), 'section-inset': pixels(section?.inset) }),
    rule('reader-page', { 'page-width': pixels(page?.maxWidth), 'page-inset': pixels(page?.inset), 'page-text-size': pixels(page?.textSize), 'page-leading': page?.lineHeight,
      'page-paper': color(page?.paperColor), 'page-ink': color(page?.inkColor), 'page-surround': color(page?.surround),
      'page-pdf-filter': page?.pdfPaper && pdfFilters[page.pdfPaper] })
  ].filter(Boolean)
  if (!rules.length) { sheet?.remove(); return }
  const css = '@layer hy-theme {\n' + rules.join('\n') + '\n}'
  if (sheet?.textContent === css) return
  const style = sheet ?? doc.createElement('style')
  style.id = 'hy-theme-parts'
  style.textContent = css
  if (!sheet) doc.head.append(style)
}
