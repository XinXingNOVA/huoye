import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { closeLibrary, libraryOf, openLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { workbenchContentWindow, workbenchSessionWindows } from '../../src/main/auxiliary-windows'
import { script, until, click, pickTheme, openThemeSettings, themeFixture } from './theme-settings'
import { findSettingsSurface } from './settings-surface'

async function checkPdfPaperSettings(owner: BrowserWindow, reader: BrowserWindow, dir: string) {
  const openDefaults = async () => {
    await click(reader, '纸面选项')
    await click(reader, '设置本库默认纸面…')
    await until(() => findSettingsSurface(owner), 'PDF 快捷入口未打开设置')
    return findSettingsSurface(owner)!
  }
  const filter = () => script(reader, `getComputedStyle(document.querySelector('[data-hy-reader=pdf] canvas')).filter`)
  const selected = (win: BrowserWindow, name: string) => script(win, `[...document.querySelectorAll('[aria-label="PDF 默认纸面"] [role=radio]')].some(b =>
    b.textContent === ${JSON.stringify(name)} && !b.disabled && b.getAttribute('aria-checked') === 'true')`)
  const panel = await openDefaults()
  await until(() => script(panel, `!!document.querySelector('[data-settings-section="library-appearance"] [aria-label="PDF 默认纸面"]')`), '未定位到本库 PDF 外观分区')
  await click(panel, '暗色反色')
  await until(async () => (await filter()).includes('invert'), '当前 PDF 未跟随本库默认纸面')
  await until(() => selected(panel, '暗色反色'), '纸面设置未保存')
  writeFileSync(join(dir, '插件外观-PDF.png'), (await panel.webContents.capturePage()).toPNG())
  const other = await openLibrary(join(dir, '独立验证.library'), { show: true })
  await click(other.win, '打开设置')
  await until(() => findSettingsSurface(other.win), '另一仓库未打开设置')
  const otherSettings = findSettingsSurface(other.win)!
  await click(otherSettings, '本库外观')
  await click(otherSettings, 'PDF')
  await until(() => selected(otherSettings, '跟随主题'), '本库默认纸面串到了另一仓库')
  await closeLibrary(other)
  await click(panel, '关闭设置')
  await until(() => !findSettingsSurface(owner), '纸面设置未关闭')
  await click(reader, '纸面选项')
  await click(reader, '原色')
  await until(async () => await filter() === 'none', '当前文档未切到原色')
  const reopened = await openDefaults()
  await until(() => selected(reopened, '暗色反色'), '重开后本库偏好丢失')
  await click(reopened, '跟随主题')
  await until(() => selected(reopened, '跟随主题'), '本库未恢复跟随主题')
  assert.equal(await filter(), 'none', '设置覆盖了文档手动纸面')
  await click(reopened, '关闭设置')
  await until(() => !findSettingsSurface(owner), '纸面设置未关闭')
  await click(reader, '纸面选项')
  await click(reader, '跟随本库默认')
  await until(async () => (await filter()).includes('sepia'), '文档未恢复主题的暖纸')
}

export async function themeReadersFlow(owner: BrowserWindow, dir: string, choose: (label: string) => void) {
  const { core } = libraryOf(owner.webContents)!
  const result = await callCore(core, 'importToLibrary', ['山间来信.epub', '共享选区.pdf'].map(name => ({ type: 'file', path: join(dir, name) })), { requestId: 'theme-readers' })
  assert.deepEqual(result.errors, [])
  const [book, pdf] = result.items.map(item => item.id)
  await until(async () => {
    const [a, b] = await callCore(core, 'get', [book, pdf])
    return a?.blocks.epub && b?.blocks.pdf
  }, '新文档尚未加工')
  const open = async (id: string) => {
    const card = `document.querySelector('[data-entity-id="${id}"][data-hy-part="resource-card"]')`
    await until(() => script(owner, card + '?.checkVisibility()'), '未找到可见素材卡')
    await script(owner, card + ".dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
  }
  await open(book)
  const bookPage = "document.querySelector('[data-hy-reader=epub] article')"
  await until(() => script(owner, '!!' + bookPage), '没有打开 EPUB 章节')
  choose('移到新窗口')
  await script(owner, `document.querySelector('[role=tab][data-tab][aria-selected=true]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))`)
  const childWindow = () => {
    const child = workbenchSessionWindows(owner).windows.find(w => w.id.startsWith('content:'))
    return child && workbenchContentWindow(owner, child.id)
  }
  await until(childWindow, '阅读器没有移入小窗')
  const child = childWindow()!
  const size = () => script(child, `getComputedStyle(${bookPage}).fontSize`)
  await until(() => script(child, '!!' + bookPage), '小窗未载入章节')
  const originalSize = await size()
  owner.show(); owner.focus()
  await open(pdf)
  const sheet = "document.querySelector('[data-hy-reader=pdf] [data-page=\"1\"]')"
  await until(() => script(owner, sheet + "?.querySelector('canvas')?.width > 0"), 'PDF 尚未绘制')
  const pageWidth = () => script(owner, sheet + '.getBoundingClientRect().width')
  const install = await openThemeSettings(owner)
  await click(install, '青瓷书房')
  for (const [mode, filter] of [['固定浅色', 'sepia'], ['固定深色', 'invert']]) {
    await click(install, mode)
    await until(() => script(owner, `getComputedStyle(${sheet}.querySelector('canvas')).filter.includes(${JSON.stringify(filter)})`), '书房纸面未切换')
    await until(async () => (await size()) === '18px' && await script(child, `getComputedStyle(${bookPage}).maxWidth === '680px'`), '书房版心未同步到 EPUB 小窗')
  }
  await click(install, '活页 · 标准')
  await pickTheme(install, themeFixture(dir, 'ink-reader.zip'))
  await click(install, '墨线书页')
  const svg = (name: string) => `[data-hy-icon="${name}"]`
  await until(() => script(child, `!!document.querySelector('${svg('list')} rect')`), 'EPUB 小窗未替换图标')
  await until(() => script(owner, `!!document.querySelector('[aria-label=放大] ${svg('plus')} circle')`), 'PDF 未替换图标')
  assert(await script(owner, `!!document.querySelector('[aria-label=缩小] ${svg('minus')} path')`))
  await until(async () => await size() === '21px', 'EPUB 字号没有跟随主题')
  const metrics = await script(child, `(() => { const s=getComputedStyle(${bookPage});return [s.maxWidth,s.paddingInlineStart,s.lineHeight] })()`)
  assert.deepEqual(metrics, ['480px', '32px', '37.8px'])
  const fit = () => script(owner, `Math.min(480, document.querySelector('[data-hy-reader=pdf]').clientWidth - 64)`)
  await until(async () => Math.abs(await pageWidth() - await fit()) < 1, 'PDF 版心不符合适应宽度')
  assert(await script(owner, `getComputedStyle(${sheet}.querySelector('canvas')).filter.includes('sepia')`))
  await click(install, '关闭设置')
  await until(() => !findSettingsSurface(owner), '主题设置未关闭')
  for (const [win, label] of [[owner, 'PDF'], [child, 'EPUB']] as const) {
    win.show()
    await script(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    writeFileSync(join(dir, '墨线书页-' + label + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await script(owner, "document.querySelector('[aria-label=放大]').click()")
  await until(() => script(owner, "document.querySelector('[aria-label=页面缩放]').value !== 'fit'"), 'PDF 手动缩放无效')
  const manual = await pageWidth()
  await script(child, "document.querySelector('.epub-settings-wrap>button').click()")
  await click(child, '增大字号')
  await until(async () => await size() === '22px', 'EPUB 手动排版无效')
  const panel = await openThemeSettings(owner)
  await click(panel, '还原内置外观')
  await until(() => script(child, `!document.querySelector('${svg('list')} rect')`), '小窗图标未还原')
  await until(() => script(owner, `!document.querySelector('[aria-label=放大] ${svg('plus')} circle')`), '主窗图标未还原')
  assert.equal(await size(), '22px')
  assert.equal(await pageWidth(), manual)
  await click(child, '恢复主题排版')
  await until(async () => await size() === originalSize, '手动字号未恢复到默认')
  await click(panel, '墨线书页')
  await click(panel, '关闭设置')
  await until(() => !findSettingsSurface(owner), '主题设置未关闭')
  choose('移到新窗口')
  await script(owner, `document.querySelector('[role=tab][data-tab][aria-selected=true]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))`)
  const pdfWindow = () => workbenchSessionWindows(owner).windows.filter(w => w.id.startsWith('content:'))
    .map(w => workbenchContentWindow(owner, w.id)).find(win => win && win.id !== child.id)
  await until(pdfWindow, 'PDF 没有移入独立窗口')
  const reader = pdfWindow()!
  await until(() => script(reader, sheet + "?.querySelector('canvas')?.width > 0"), 'PDF 小窗尚未绘制')
  await checkPdfPaperSettings(owner, reader, dir)
  writeFileSync(join(dir, 'theme-readers-result.json'), JSON.stringify({ book, pdf, metrics, originalSize }))
}
