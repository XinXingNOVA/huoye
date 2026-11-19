import { expect, it } from 'vitest'
import { renderTextMarkdown } from '../../src/plugins/text/markdown-render'

const ring = String.raw`\mathbb Z[\sqrt2]=\{x+y\sqrt2:x,y\in\mathbb Z\}.`
it('文字的 Markdown 阅读、卡片及预览共用行内、块公式和 math 围栏语法', () => {
  for (const source of [`$${ring}$`, String.raw`\(${ring}\)`, `$$\n${ring}\n$$`, String.raw`\[${ring}\]`, '```math\n' + ring + '\n```']) {
    for (const live of [false, true]) {
      const html = renderTextMarkdown(source, live)
      expect(html).toContain('class="katex"')
      expect(html).toContain('mathvariant="double-struck"')
      expect(html).toContain('<msqrt>')
    }
  }
  expect(renderTextMarkdown(`$$\n${ring}\n$$`)).toContain('text-math-block')
})
it('公式不吞掉双链、嵌入、普通链接和后续文字，静态与阅读模式保持各自语义', () => {
  const source = String.raw`$\sqrt{2}$ [[读书笔记|另篇]] ![[素材]] [网页](https://example.com) **结束**`
  expect(renderTextMarkdown(source)).toContain('class="wikilink static">另篇')
  const html = renderTextMarkdown(source, true)
  expect(html).toContain('class="wikilink-slot" data-ref="读书笔记" data-label="另篇"')
  expect(html).toContain('class="embed-slot" data-embed="" data-ref="素材"')
  expect(html).toContain('href="https://example.com"')
  expect(html).toContain('<strong>结束</strong>')
  for (const raw of ['`$x^2$`', '```latex\n' + ring + '\n```', '价格 $20，另一个 $30。', String.raw`\$x^2\$`]) {
    expect(renderTextMarkdown(raw)).not.toContain('class="katex"')
  }
})
it('不完整、错误、超长公式和循环宏回退源码；宏不跨公式泄漏', () => {
  for (const raw of ['$$\n' + ring, String.raw`\[${ring}`, String.raw`\(${ring}`, String.raw`$\frac{1}{$`, '$$' + 'x'.repeat(8001) + '$$', String.raw`$\def\loop{\loop}\loop$`]) {
    expect(renderTextMarkdown(raw)).toContain('text-math-source')
  }
  renderTextMarkdown(String.raw`$\gdef\localonly{123}\localonly$`)
  expect(renderTextMarkdown(String.raw`$\localonly$`)).toContain('text-math-source')
})
it('公式和 Markdown 不执行 HTML、不加载远程图片，危险链接不能变成可执行元素', () => {
  const html = renderTextMarkdown(String.raw`$\href{javascript:alert(1)}{x}$ $\includegraphics{https://example.invalid/a.png}$ $\htmlClass{bad}{x}$` + '\n<script>bad()</script>\n![alt](https://example.invalid/a.png)')
  expect(html).not.toMatch(/<script|<img|href="javascript:|class="bad"/)
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('class="md-image"')
})
