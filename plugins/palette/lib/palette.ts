// 从像素中提取主要颜色：在 Lab 空间做加权 k-means。

interface Lab {
  l: number
  a: number
  b: number
}

export interface Swatch {
  hex: string
  weight: number
}

/** pixels：RGB 连续排列（3 字节一个像素）。 */
export function extractPalette(pixels: Uint8Array | Buffer, k = 6, iterations = 12): Swatch[] {
  const n = Math.floor(pixels.length / 3)
  if (n === 0) return []
  const labs: Lab[] = new Array(n)
  for (let i = 0; i < n; i++) labs[i] = rgbToLab(pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2])

  // 初始中心：按亮度排序后等距取点，结果稳定可复现
  const sorted = [...labs].sort((x, y) => x.l - y.l)
  const kk = Math.min(k, n)
  let centers: Lab[] = Array.from({ length: kk }, (_, i) => ({ ...sorted[Math.floor(((i + 0.5) * n) / kk)] }))
  const assign = new Int32Array(n)

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(labs[i], centers[c])
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      assign[i] = best
    }
    const sums = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }))
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]]
      s.l += labs[i].l
      s.a += labs[i].a
      s.b += labs[i].b
      s.n++
    }
    centers = sums.map((s, c) => (s.n ? { l: s.l / s.n, a: s.a / s.n, b: s.b / s.n } : centers[c]))
  }

  const counts = new Array(centers.length).fill(0)
  for (let i = 0; i < n; i++) counts[assign[i]]++

  // 合并过于接近的颜色，去掉占比很小的
  const swatches: { lab: Lab; count: number }[] = []
  centers
    .map((lab, c) => ({ lab, count: counts[c] }))
    .sort((x, y) => y.count - x.count)
    .forEach((s) => {
      const near = swatches.find((t) => Math.sqrt(dist2(t.lab, s.lab)) < 10)
      if (near) near.count += s.count
      else if (s.count > 0) swatches.push(s)
    })

  return swatches
    .filter((s) => s.count / n >= 0.02)
    .map((s) => ({ hex: labToHex(s.lab), weight: Math.round((s.count / n) * 1000) / 1000 }))
}

function dist2(x: Lab, y: Lab): number {
  return (x.l - y.l) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2
}

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

const XN = 0.95047
const YN = 1
const ZN = 1.08883

function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r)
  const G = srgbToLinear(g)
  const B = srgbToLinear(b)
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / XN
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / YN
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / ZN
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

function labToHex({ l, a, b }: Lab): string {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
  const x = inv(fx) * XN
  const y = inv(fy) * YN
  const z = inv(fz) * ZN
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415
  const B = x * 0.0557 + y * -0.204 + z * 1.057
  return '#' + [R, G, B].map((v) => linearToSrgb(v).toString(16).padStart(2, '0')).join('')
}
