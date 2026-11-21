import assert from 'node:assert/strict'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import sharp from 'sharp'
import { localThemes } from '../../src/main/appearance'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { findSettingsSurface } from './settings-surface'
import { script, until, pickTheme, click, themeFixture } from './theme-settings'

function art(win: BrowserWindow) {
  return script(win, `(() => {
    const root = document.documentElement, shell = document.querySelector('.app, .content-window')
    const layer = getComputedStyle(shell, '::before'), sticker = getComputedStyle(shell, '::after')
    return { wallpaper: layer.backgroundImage, sticker: sticker.backgroundImage, opacity: layer.opacity,
      focusThrough: layer.pointerEvents === 'none' && sticker.pointerEvents === 'none',
      blur: getComputedStyle(document.querySelector('.window-toolbar')).backdropFilter,
      active: root.hasAttribute('data-hy-wallpaper') }
  })()`)
}
const loadedWidth = (win: BrowserWindow, css: string) => script(win, `new Promise(resolve => {
  const image = new Image(); image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve(0)
  image.src = ${JSON.stringify(css.slice(5,-2))}
})`)

async function selectReaderText(win: BrowserWindow) {
  const points = await script(win, `(() => {
    const tree = document.createTreeWalker(document.querySelector('[aria-label="阅读正文"]'), NodeFilter.SHOW_TEXT)
    let text; while ((text = tree.nextNode()) && !text.textContent.includes('检查装饰')) {}
    const point = (i) => { const r = document.createRange(); r.setStart(text, i); r.collapse(true)
      const b = r.getBoundingClientRect(); return {x:b.x+1, y:b.y+b.height/2} }
    return [point(0), point(4)]
  })()`)
  const debug = win.webContents.debugger
  debug.attach()
  try {
    await debug.sendCommand('Input.dispatchMouseEvent', { type:'mousePressed', ...points[0], button:'left', buttons:1, clickCount:1 })
    await debug.sendCommand('Input.dispatchMouseEvent', { type:'mouseMoved', ...points[1], button:'left', buttons:1 })
    await debug.sendCommand('Input.dispatchMouseEvent', { type:'mouseReleased', ...points[1], button:'left', buttons:0, clickCount:1 })
    await until(() => script(win, "getSelection().toString() === '检查装饰'"), '装饰后独立阅读窗未能拖选正文')
  } finally { debug.detach() }
}

async function dragGlassSlider(settings: BrowserWindow, owner: BrowserWindow, child: BrowserWindow, other: BrowserWindow) {
  const { id } = libraryOf(owner.webContents)!
  const saved = () => localThemes().snapshot(id)
  const revision = saved().revision
  const { left, right, y } = await script(settings, `(() => {
    const slider = document.querySelector('[aria-label="毛玻璃模糊"]')
    slider.scrollIntoView({ block: 'center' })
    const rect = slider.getBoundingClientRect()
    return { left: rect.left + 1, right: rect.right - 1, y: rect.y + rect.height / 2 }
  })()`)
  const debug = settings.webContents.debugger
  debug.attach()
  try {
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: left, y, button: 'left', buttons: 1, clickCount: 1 })
    for (const win of [owner, child]) await until(async () => (await art(win)).blur === 'none', '按住滑杆时未能预览关闭模糊')
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: right, y, button: 'left', buttons: 1 })
    for (const win of [owner, child]) await until(async () => (await art(win)).blur === 'blur(16px)', '拖动时毛玻璃未实时同步')
    assert.equal(saved().revision, revision, '拖动过程中写入了外观配置')
    assert.equal((await art(other)).blur, 'none', '另一仓库受到了临时预览影响')
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: right, y, button: 'left', buttons: 0, clickCount: 1 })
    await until(() => saved().decoration?.surfaceBlur === 16, '松手后未保存最终值')
    assert.equal(saved().revision, revision + 1)
  } finally { debug.detach() }
}

export async function decorationFlow(owner: BrowserWindow, child: BrowserWindow, other: BrowserWindow, dir: string,
  choose: (label: string) => void, open: () => Promise<BrowserWindow>) {
  const { core, id: libraryId } = libraryOf(owner.webContents)!
  const wallpaper = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#409c78' } }).png().toBuffer()
  const file = themeFixture(dir, 'celadon-mist.zip')
  const settings = await open()
  await click(settings, '单独设置')
  await pickTheme(settings, file)
  await click(settings, '青瓷薄雾')
  for (const win of [owner, child]) {
    await until(async () => (await art(win)).wallpaper.includes('huoye-theme://assets/'), '窗口未绘制包内壁纸')
    const state = await art(win)
    assert(state.focusThrough)
    assert.equal(state.opacity, '0.54')
    assert.equal(state.blur, 'blur(6px)')
    assert.equal(await loadedWidth(win, state.sticker), 192)
  }
  assert.equal(await script(owner, `getComputedStyle(document.querySelector('[data-hy-part="resource-card"]')).backdropFilter`), 'none',
    '旧版主题的卡片应保留透明底色并默认关闭逐卡模糊')
  assert(!(await art(other)).active)
  await until(() => script(owner, `(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    const alpha = selector => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = getComputedStyle(document.querySelector(selector)).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
      return ctx.getImageData(0, 0, 1, 1).data[3]
    }
    const corner = alpha('.window-corner'), tab = alpha('[data-editor-header] [role="tab"][aria-selected="true"]')
    const card = alpha('[data-hy-part="resource-card"]')
    return card > 0 && card < 255 && corner > 0 && corner < 255 && alpha('[aria-label="常用操作"]') === corner &&
      alpha('.sidebar-group-heading') === 0 && tab > 0 && tab < 255
  })()`), '主题切换后卡片或工作台表面未采用指定的透明度')

  const personal = join(dir, '本机背景.png')
  writeFileSync(personal, wallpaper)
  await pickTheme(settings, personal, '选择壁纸')
  await until(async () => (await art(owner)).wallpaper.includes('huoye-theme://library/' + libraryId), '本机图片未落盘')
  await pickTheme(settings, personal, '选择角落贴纸')
  await until(async () => (await art(child)).sticker.includes('huoye-theme://library/' + libraryId), '小窗未采用本机贴纸')
  await click(settings, '隐藏角落贴纸')
  await until(async () => (await art(owner)).sticker === 'none', '单独隐藏贴纸未生效')
  unlinkSync(personal)
  assert.equal(await loadedWidth(child, (await art(child)).wallpaper), 160)
  await script(settings, `Array.from(document.querySelectorAll('summary')).find(e=>e.textContent==='调整壁纸、贴纸与表面').click()`)
  await dragGlassSlider(settings, owner, child, other)
  await script(settings, `document.querySelector('[aria-label="壁纸不透明度"]').focus()`)
  settings.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'})
  await until(async () => (await art(child)).opacity === '0.55', '键盘未能调整壁纸强度')
  assert.equal(localThemes().snapshot(libraryId).decoration?.wallpaperOpacity, undefined, '按键尚未松开就保存了壁纸强度')
  settings.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'})
  await until(() => localThemes().snapshot(libraryId).decoration?.wallpaperOpacity === 55, '松键后未保存壁纸强度')
  assert(await script(settings, `document.activeElement.getAttribute('aria-label') === '壁纸不透明度'`))
  await click(settings, '关闭设置')
  await until(() => !findSettingsSurface(owner), '设置未关闭')
  await selectReaderText(child)

  const image = join(dir, '素材壁纸.png')
  writeFileSync(image, wallpaper)
  const result = await callCore(core, 'importToLibrary', [{ type:'file', path:image }], {requestId:'theme-decoration-import'})
  assert.deepEqual(result.errors, [])
  const id = result.items[0].id
  await until(async () => (await callCore(core,'get',[id]))[0]?.blocks.thumb, '新图没有完成加工')
  owner.show(); owner.focus()
  await script(owner, `Array.from(document.querySelectorAll('[role="tab"]')).find(t => t.textContent.includes('全部'))?.click()`)
  const card = `document.querySelector('[data-hy-part="resource-card"][data-entity-id="${id}"]')`
  await until(() => script(owner, '!!' + card), '新导入的图片未显示')
  const pt = await script(owner, `(() => { const rect=${card}.getBoundingClientRect()
    return {x: Math.round(rect.x+20), y: Math.round(rect.y+20)} })()`)
  owner.webContents.sendInputEvent({type:'mouseDown', ...pt, button:'left', clickCount:1})
  owner.webContents.sendInputEvent({type:'mouseUp', ...pt, button:'left', clickCount:1})
  await until(() => script(owner, "document.querySelector('#inspector-panel')?.innerText.includes('素材壁纸.png')"), '装饰后点击没有选中图片')
  choose('设为本库壁纸')
  await script(owner, `${card}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  await until(async () => (await art(owner)).wallpaper.startsWith('url("lib://' + libraryId), '右键未采用本库的文件引用')
  assert.equal(await loadedWidth(child, (await art(child)).wallpaper), 160)
  writeFileSync(join(dir,'工作台壁纸.png'), (await owner.webContents.capturePage()).toPNG())
  await callCore(core, 'trash', [id])
  await until(async () => (await art(owner)).wallpaper === 'none', '回收素材后仍绘制原图')
  await callCore(core, 'restore', [id])
  await until(async () => (await art(child)).wallpaper.includes('lib://'), '恢复素材后壁纸未恢复')
  const panel = await open()
  await click(panel, '恢复主题装饰')
  await until(async () => (await art(owner)).wallpaper.includes('huoye-theme://assets/'), '未恢复包内壁纸')
  await until(async () => (await art(owner)).sticker.includes('huoye-theme://assets/'), '未恢复包内贴纸')
  await click(panel, '关闭设置')
  await until(() => !findSettingsSurface(owner), '恢复主题后设置窗口未关闭')
  owner.show(); owner.focus()
  const restored = await art(owner)
  assert(await loadedWidth(owner, restored.wallpaper) > 0 && await loadedWidth(owner, restored.sticker) > 0)
  await until(() => script(owner, "!document.body.innerText.includes('已设为本库壁纸')"), '素材操作提示未消失')
  await script(owner, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  writeFileSync(join(dir, '青瓷薄雾.png'), (await owner.webContents.capturePage()).toPNG())
  await click(await open(), '恢复跟随应用')
  for (const win of [owner, child, other]) await until(async () => !(await art(win)).active && (await art(win)).sticker === 'none', '装饰未清理')
  writeFileSync(join(dir,'theme-decoration-result.json'), JSON.stringify({libraryId, material:id}))
}
