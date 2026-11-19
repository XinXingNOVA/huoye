// 瀑布流布局：只依赖宽高比，缩略图出来之前位置就是对的。

export interface MasonryLayout {
  x: Float32Array
  y: Float32Array
  h: Float32Array
  colWidth: number
  height: number
}

export function computeMasonry(aspects: number[], width: number, target: number, gap: number, captionHeight: number): MasonryLayout {
  const n = aspects.length
  const cols = Math.max(1, Math.floor((width + gap) / (target + gap)))
  const colWidth = Math.max(40, (width - gap * (cols - 1)) / cols)
  const colHeights = new Float64Array(cols)
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  const h = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    // 宽高比未知时按正方形占位；极端比例限制在 1:4 ~ 4:1
    const a = aspects[i] > 0 ? Math.min(4, Math.max(0.25, aspects[i])) : 1
    let c = 0
    for (let j = 1; j < cols; j++) if (colHeights[j] < colHeights[c]) c = j
    x[i] = c * (colWidth + gap)
    y[i] = colHeights[c]
    h[i] = colWidth / a + captionHeight
    colHeights[c] += h[i] + gap
  }

  let height = 0
  for (let j = 0; j < cols; j++) height = Math.max(height, colHeights[j])
  return { x, y, h, colWidth, height }
}
