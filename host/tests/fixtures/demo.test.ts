// 生成一个演示素材库：DEMO_LIB=<目录> npx vitest run tests/fixtures/demo.test.ts
// 用合成图片、文字摘录、普通文件走一遍真实的接入与加工流程。默认跳过。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, it } from 'vitest'
import { Host } from '../../src/core/host'
import { legacyCorePlugins as corePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { tempDir } from '../helpers/helpers'

const DEMO_MD = `# 《设计中的设计》读书笔记

> 设计不是一种技能，而是捕捉事物本质的感觉能力。

## 几个要点

- **再设计**：从熟悉的东西里重新发现问题
- 信息的建筑：把看不见的结构做出来
- 留白不是"空"，是*可以放进东西*的余地

## 想试试的

1. 给素材库的卡片做一版留白更多的排版
2. 找三张"空"得好的海报

| 概念 | 我的理解 |
| --- | --- |
| 再设计 | 换个角度看日常 |
| 留白 | 给想象的位置 |

原书信息见 [出版社页面](https://example.com/book)。
`

/** 演示用的 PDF：三页，第一页讲留白，第二页讲网格，第三页讲节奏。 */
const PDF_TEXT = [
  '版式手册',
  '',
  '第一章 留白',
  '留白不是空，是给视线休息的位置。',
  ...Array.from({ length: 60 }, (_, i) => `  第一章的第 ${i + 1} 条笔记`),
  '第二章 网格',
  '网格让版面有秩序，十二栏最常用。',
  ...Array.from({ length: 60 }, (_, i) => `  第二章的第 ${i + 1} 条笔记`),
  '第三章 节奏',
  '大小、疏密交替，版面才有节奏感。'
].join('\n')

/** "旧摘抄"：中文旧文本文件常见的 GB18030 编码（"简约，但不简单。"）。 */
const GB18030_TEXT = Buffer.from('bcf2d4bca3acb5abb2bbbcf2b5a5a1a3', 'hex')

const WEB_EXCERPT_TEXT = '留白的力量\n画面里空的地方也是构图。\n留白给视线休息的位置\n留白让主体更突出'
const WEB_EXCERPT_HTML =
  '<meta charset="utf-8"><h2>留白的力量</h2><p>画面里<strong>空的地方</strong>也是构图。</p><ul><li>留白给视线休息的位置</li><li>留白让主体更突出</li></ul>'

const PALETTES = [
  ['#0f2027', '#203a43', '#2c5364', '#f9d423'],
  ['#ff5f6d', '#ffc371', '#2b2d42', '#edf2f4'],
  ['#1d2b64', '#f8cdda', '#6a0572', '#ab83a1'],
  ['#134e5e', '#71b280', '#f4f1de', '#e07a5f'],
  ['#000428', '#004e92', '#e0eafc', '#cfdef3'],
  ['#3a1c71', '#d76d77', '#ffaf7b', '#1b1b2f'],
  ['#232526', '#414345', '#ff7e5f', '#feb47b'],
  ['#5a3f37', '#2c7744', '#e8d5b7', '#0e2431']
]
const SIZES: [number, number][] = [
  [1600, 1000], [1000, 1500], [1200, 1200], [1920, 1080], [900, 1600], [1500, 1000],
  [1080, 1350], [2000, 800], [1200, 1800], [1400, 1050], [800, 1200], [1600, 900]
]

function svg(w: number, h: number, [a, b, c, d]: string[], seed: number): string {
  const r = (n: number) => ((Math.sin(seed * 97.13 + n * 13.7) + 1) / 2)
  const circles = Array.from({ length: 5 }, (_, i) => {
    const cx = Math.round(r(i) * w)
    const cy = Math.round(r(i + 10) * h)
    const rad = Math.round((0.08 + r(i + 20) * 0.25) * Math.min(w, h))
    return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${i % 2 ? c : d}" opacity="${0.35 + r(i + 30) * 0.5}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>${circles}
    <rect x="${w * 0.08}" y="${h * 0.78}" width="${w * 0.5}" height="${h * 0.04}" fill="${d}" opacity="0.8"/>
  </svg>`
}

/** 用 ffmpeg 的内置画面源生成几段演示视频（没有 ffmpeg 时跳过）。 */
const VIDEOS: [string, string[]][] = [
  ['分形.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
  ['生命游戏.mp4', ['-f', 'lavfi', '-i', 'life=size=480x480:mold=10:rate=12:ratio=0.3:death_color=#1b1630:life_color=#ffb86b', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ['竖屏.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ['色条.webm', ['-f', 'lavfi', '-i', 'smptehdbars=size=1280x720:rate=25', '-t', '5', '-c:v', 'libvpx-vp9', '-b:v', '1M']],
  ['旧格式.avi', ['-f', 'lavfi', '-i', 'gradients=size=960x540:rate=25:speed=0.05', '-f', 'lavfi', '-i', 'sine', '-t', '6', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame']]
]

const TEXTS = [
  '好的设计是尽可能少的设计。\n——迪特·拉姆斯',
  '先推后摇，节奏卡在鼓点上。转场用的是遮挡物，镜头经过前景的柱子时切到下一场。',
  '配色：主色压到 60%，辅色 30%，点缀 10%。冷暖对比放在视觉中心。'
]

describe.skipIf(!process.env.DEMO_LIB)('演示库', () => {
  it('生成', async () => {
    const root = process.env.DEMO_LIB!
    mkdirSync(root, { recursive: true })
    const host = new Host(root, corePlugins, () => {}, { manifest: legacyManifest })
    const src = tempDir('rm-demo-src-')

    const files: string[] = []
    for (let i = 0; i < 24; i++) {
      const [w, h] = SIZES[i % SIZES.length]
      const path = join(src, `作品_${String(i + 1).padStart(2, '0')}.${i % 3 === 0 ? 'jpg' : 'png'}`)
      const img = sharp(Buffer.from(svg(w, h, PALETTES[i % PALETTES.length], i + 1)))
      await (i % 3 === 0 ? img.jpeg({ quality: 85 }) : img.png()).toFile(path)
      files.push(path)
    }
    const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)
    const videos = ffmpeg
      ? VIDEOS.map(([name, args]) => {
          execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, join(src, name)])
          return join(src, name)
        })
      : []
    writeFileSync(join(src, '会议记录.txt'), '下周交初稿')
    // 文档：一篇 Markdown 读书笔记，一个 GB18030 编码的旧文本文件
    writeFileSync(join(src, '读书笔记.md'), DEMO_MD)
    writeFileSync(join(src, '旧摘抄.txt'), GB18030_TEXT)
    // PDF：用系统的 cupsfilter 把一段文字排成三页（没有时跳过）
    const cupsfilter = ['/usr/sbin/cupsfilter', '/usr/bin/cupsfilter'].find(existsSync)
    const pdfs: string[] = []
    if (cupsfilter) {
      writeFileSync(join(src, '版式手册.txt'), PDF_TEXT)
      writeFileSync(join(src, '版式手册.pdf'), execFileSync(cupsfilter, ['-m', 'application/pdf', join(src, '版式手册.txt')], { stdio: ['ignore', 'pipe', 'ignore'] }))
      pdfs.push(join(src, '版式手册.pdf'))
    }
    writeFileSync(join(src, '损坏的图片.jpg'), 'not really a jpeg')

    const ids = await host.api.ingest([
      ...files.map((path) => ({ type: 'file' as const, path })),
      ...videos.map((path) => ({ type: 'file' as const, path })),
      { type: 'file', path: join(src, '会议记录.txt') },
      { type: 'file', path: join(src, '读书笔记.md') },
      { type: 'file', path: join(src, '旧摘抄.txt') },
      ...pdfs.map((path) => ({ type: 'file' as const, path })),
      // 从网页复制的一段：带格式和来源
      { type: 'text', text: WEB_EXCERPT_TEXT, html: WEB_EXCERPT_HTML, source: { url: 'https://www.example.com/articles/whitespace' } },
      { type: 'file', path: join(src, '损坏的图片.jpg') },
      ...TEXTS.map((text) => ({ type: 'text' as const, text }))
    ])

    const tagSets = [['配色', '渐变'], ['构图'], ['配色', '海报'], ['光影'], ['构图', '光影'], ['海报']]
    ids.slice(0, 24).forEach((id, i) => {
      if (i % 2 === 0) host.store.put(id, 'tags', { values: tagSets[i % tagSets.length] })
    })
    host.store.put(ids[0], 'note', { text: '冷暖对比很漂亮，右下角的留白可以借鉴。' })
    host.store.put(ids[ids.length - 2], 'tags', { values: ['运镜', '节奏'] })
    for (const id of ids.slice(24, 24 + videos.length)) host.store.put(id, 'tags', { values: ['视频'] })
    // 状态：看板演示用，留一部分"未设置"
    const statuses = ['待处理', '进行中', '已完成', '搁置', '待处理', '进行中']
    ids.slice(0, 12).forEach((id, i) => host.store.put(id, 'status', { value: statuses[i % statuses.length] }))
    host.store.put(ids[ids.length - 1], 'status', { value: '待处理' })

    await host.scheduler.idle()
    host.close()
  }, 120_000)
})
