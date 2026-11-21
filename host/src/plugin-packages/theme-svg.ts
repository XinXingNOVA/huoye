import { DOMParser } from '@xmldom/xmldom'
import { iconDrawing, type IconDrawing } from '../shared/theme-icons'

const namespace = 'http://www.w3.org/2000/svg'
const paintAttrs: Record<string, string> = {
  fill: 'fill', stroke: 'stroke', 'stroke-width': 'strokeWidth', 'fill-rule': 'fillRule',
  'stroke-linejoin': 'strokeLinejoin', 'stroke-linecap': 'strokeLinecap',
  opacity: 'opacity', 'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity'
}

/** 只交付可绘制的几何数据。原始 XML、元素名和属性均不直接进入渲染器。 */
export function readThemeIcon(data: Uint8Array, name: string): IconDrawing {
  const fail = (): never => { throw new Error('图标需要受支持的静态 SVG 图形：' + name) }
  if (data.length > 16 * 1024) fail()
  let xml = new TextDecoder('utf-8', { fatal: true }).decode(data).trim()
  xml = xml.replace(/^<\?xml version="1\.0"(?: encoding="UTF-8")?\s*\?>\s*/i, '')
  if (!xml || /<!|<\?|&/.test(xml)) fail()
  const doc = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(xml, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.tagName !== 'svg' || (root.namespaceURI && root.namespaceURI !== namespace)) fail()
  const shapes: { tag: string; attrs: Record<string, string> }[] = []
  let count = 0
  function visit(el: Element, inherited: Record<string, string>, depth: number) {
    if (++count > 128 || depth > 8 || (el.namespaceURI && el.namespaceURI !== namespace)) fail()
    const container = el === root || el.tagName === 'g'
    const attrs = { ...inherited }
    for (let i = 0; i < el.attributes.length; i++) {
      const { name: key, value } = el.attributes.item(i)!
      if (el === root && ['xmlns', 'viewBox'].includes(key)) continue
      if (el === root && ['width', 'height'].includes(key) && /^\d+(?:\.\d+)?(?:px)?$/.test(value)) continue
      // 分组透明度涉及合成顺序，不能摊平到各个子图形上。
      if (container && key === 'opacity') fail()
      if (Object.hasOwn(paintAttrs, key)) attrs[paintAttrs[key]] = value
      else if (!container && /^(d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|width|height|points)$/.test(key)) attrs[key] = value
      else fail()
    }
    if (!container) shapes.push({ tag: el.tagName, attrs })
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3 && !node.nodeValue?.trim()) continue
      if (!container || node.nodeType !== 1) fail()
      visit(node as Element, attrs, depth + 1)
    }
  }
  visit(root, {}, 0)
  const result = iconDrawing.safeParse({ viewBox: root.getAttribute('viewBox') || '0 0 24 24', shapes })
  if (!result.success) return fail()
  return result.data
}
