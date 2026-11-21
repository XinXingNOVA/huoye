import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { executeUiCommand } from './capture-command'
import { findSettingsSurface } from './settings-surface'
import { button, click, openThemeSettings, pickTheme, script, until, themeFixture } from './theme-settings'

const page = 'document.querySelector(\'[role="article"][data-hy-part="reader-page"]\')'
const section = 'document.querySelector(\'[data-hy-part="inspector-section"]\')'

function reading(win: BrowserWindow) {
  return script(win, `(() => {
    const el = ${page}, body = el?.querySelector('p')
    if (!body) return null
    const paper = getComputedStyle(el), text = getComputedStyle(body)
    return [paper.maxWidth, paper.paddingInlineStart, text.fontSize, text.lineHeight]
  })()`)
}

export async function themePartsFlow(owner: BrowserWindow, dir: string, choose: (label: string) => void) {
  const main = (code: string) => script(owner, code)
  await until(() => main('!!document.querySelector(\'[aria-label="打开设置"]\')'), '工作台未就绪')
  const { core } = libraryOf(owner.webContents)!
  const ids: string[] = []
  for (const [title, body] of [
    ['木刻试印', '在试印纸上记录墨色浓淡，等油墨干透再比较两张印样。'],
    ['套色记录', '第二次套印时把赭色压在墨线上，可以看出纸张吃墨的差异。'],
    ['纸样与墨色', '棉纸的边缘略有毛刺，斜光下能看到压印的纹理。']
  ]) {
    const { id } = await callCore(core, 'run', 'text', 'create', { content: '# ' + title + '\n\n' + body }) as { id: string }
    ids.push(id)
  }
  await executeUiCommand(main, 'host.view.all')
  const card = (id: string) => `[...document.querySelectorAll('[data-hy-part="resource-card"][data-entity-id="${id}"]')].find(c => c.checkVisibility())`
  const caption = (id: string) => card(id) + '?.querySelector(\'[data-hy-part="card-caption"]\')'
  const fire = (id: string, event: string) => main(`${caption(id)}.dispatchEvent(new MouseEvent('${event}', { bubbles: true, button: 0 }))`)
  await until(() => main(`${caption(ids[0])}?.textContent.includes('木刻试印')`), '素材尚未显示')
  await fire(ids[0], 'dblclick')
  await until(() => main(`${page}?.innerText.includes('试印纸')`), '卡片未打开相应正文')
  choose('移到新窗口')
  await main(`document.querySelector('[role="tab"][data-tab][aria-selected="true"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  const detached = () => BrowserWindow.getAllWindows().find(w => w !== owner && w.webContents.getURL() === 'about:blank')
  await until(() => !!detached(), '阅读页没有移入小窗')
  const child = detached()!
  await until(() => reading(child), '小窗正文尚未排版')
  const oldReading = await reading(child)
  await until(() => main(`!!${caption(ids[1])}`), '主窗没有回到素材集合')
  const metrics = () => main(`(() => {
    const card = ${card(ids[1])}, cover = card.querySelector('[data-hy-part="card-cover"]')
    const caption = card.querySelector('[data-hy-part="card-caption"]'), rect = card.getBoundingClientRect()
    const label = caption.getBoundingClientRect(), x = Math.floor(label.left + label.width/2), y = Math.floor(label.top + label.height/2)
    return { width: rect.width, height: rect.height, x, y, within: label.top >= rect.top && label.bottom <= rect.bottom + 1,
      hit: document.elementFromPoint(x,y)?.closest('[data-entity-id]')?.dataset.entityId,
      frame: getComputedStyle(cover).borderTopWidth, position: getComputedStyle(caption).position,
      align: getComputedStyle(caption).textAlign, weight: getComputedStyle(caption).fontWeight }
  })()`)
  const original = await metrics()
  const sample = themeFixture(dir, 'letterpress-album.json')
  const pkg = JSON.parse(readFileSync(sample, 'utf8'))
  const settings = await openThemeSettings(owner)
  await pickTheme(settings, sample)
  await until(() => script(settings, '!!' + button(pkg.name)), '主题没有安装')
  await click(settings, pkg.name)
  await until(async () => (await reading(child))?.[0] === '640px', '阅读小窗没有同步部位样式')
  assert.deepEqual(await reading(child), ['640px', '32px', '18px', '34.2px'])
  async function closeSettings(win: BrowserWindow) {
    await click(win, '关闭设置')
    await until(() => !findSettingsSurface(owner), '设置未关闭')
    owner.focus()
  }
  await closeSettings(settings)
  const themed = await metrics()
  assert.equal(themed.frame, '4px')
  assert.equal(themed.position, 'absolute')
  assert.equal(themed.align, 'center')
  assert.equal(themed.weight, '600')
  assert.deepEqual([themed.width, themed.height], [original.width, original.height])
  assert(themed.within)
  assert.equal(themed.hit, ids[1])
  for (const type of ['mouseDown', 'mouseUp'] as const) {
    owner.webContents.sendInputEvent({ type, x: themed.x, y: themed.y, button: 'left', clickCount: 1 })
  }
  await until(() => main(`!!${section}?.checkVisibility()`), '点击题签后详情分区未显示')
  const panel = await main(`(() => { const style = getComputedStyle(${section}); return [style.paddingLeft,style.borderRadius,style.backgroundColor] })()`)
  assert.deepEqual(panel, ['10px', '6px', 'rgb(226, 227, 217)'])
  const fold = section + '.querySelector("button[aria-expanded]")'
  await main(fold + '.click()')
  await until(() => main(`${fold}.getAttribute('aria-expanded') === 'false' && document.getElementById(${fold}.getAttribute('aria-controls')).hidden`), '分区折叠失效')
  await main(fold + '.click()')
  for (const [win, name] of [[owner, 'main'], [child, 'reader']] as const) {
    writeFileSync(join(dir, 'theme-parts-' + name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await main(`document.querySelector('[aria-label="搜索内容"]').focus()`)
  await owner.webContents.insertText('赭色')
  await until(() => main(`(() => {
    const card = ${card(ids[1])}, mark = card?.querySelector('mark')
    const label = ${caption(ids[1])}
    return mark?.textContent === '赭色' && getComputedStyle(label).position === 'static' &&
      mark.getBoundingClientRect().bottom <= label.getBoundingClientRect().top
  })()`), '命中的摘录被题签遮住')
  await click(owner, '清除搜索内容')
  await until(async () => (await metrics()).position === 'absolute', '清空搜索后未恢复浮动题签')
  await fire(ids[1], 'dblclick')
  await until(() => main(`${page}?.innerText.includes('第二次套印')`), '浮动题签未打开选中的素材')
  const manage = await openThemeSettings(owner)
  const changed = join(dir, '新版.hytheme')
  writeFileSync(changed, JSON.stringify({ ...pkg, parts: { 'reader-page': { textSize: 999 } } }))
  await pickTheme(manage, changed)
  await until(() => script(manage, `document.querySelector('[role="alert"]')?.textContent.includes('parts.reader-page.textSize')`), '越界部位值没有明确反馈')
  assert.equal((await reading(child))[0], '640px')
  writeFileSync(changed, JSON.stringify({ ...pkg, parts: { 'reader-page': { maxWidth: 700 } } }))
  await pickTheme(manage, changed)
  for (const win of [owner, child]) {
    await until(async () => (await reading(win))?.[0] === '700px', '更新包未同步')
    assert.deepEqual((await reading(win)).slice(1), oldReading.slice(1), '已移除的部位值仍残留')
    assert.equal(await script(win, 'document.documentElement.hasAttribute("data-hy-overlay-caption")'), false)
  }
  await click(manage, '还原内置外观')
  for (const win of [owner, child]) {
    await until(async () => (await reading(win))?.[0] === oldReading[0], '版心未还原')
    assert.deepEqual(await reading(win), oldReading)
    assert.equal(await script(win, '!!document.getElementById("hy-theme-parts")'), false)
  }
  writeFileSync(join(dir, 'theme-parts-result.json'), JSON.stringify({ theme: pkg.name, card: themed, inspector: panel, originalReading: oldReading }))
}
