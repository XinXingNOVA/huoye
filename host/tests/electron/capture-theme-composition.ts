import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import sharp from 'sharp'
import { unzipSync, zipSync } from 'fflate'
import { script, until, click, pickTheme } from './theme-settings'

async function composition(win: BrowserWindow) {
  return script(win, `(() => {
    const shell = document.querySelector('.app, .content-window')
    const wall = getComputedStyle(shell, '::before'), sticker = getComputedStyle(shell, '::after')
    return { fit: wall.backgroundSize, repeat: wall.backgroundRepeat, anchor: wall.backgroundPosition,
      corner: sticker.backgroundPosition, opacity: sticker.opacity, width: parseFloat(sticker.width),
      blurCards: document.documentElement.hasAttribute('data-hy-blur-cards') }
  })()`)
}

async function choose(settings: BrowserWindow, label: string, value: string) {
  await script(settings, `(() => {
    const el = document.querySelector('select[aria-label=' + CSS.escape(${JSON.stringify(label)}) + ']')
    el.value = ${JSON.stringify(value)}
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

async function installPreview(panel: BrowserWindow, path: string, name: string) {
  await pickTheme(panel, path)
  await until(() => script(panel, `(() => {
    const img = document.querySelector('button[aria-label=' + CSS.escape(${JSON.stringify(name)}) + '] img')
    img?.scrollIntoView({block:'nearest'})
    return img?.complete && img.naturalWidth > 0 && img.currentSrc.startsWith('huoye-theme://assets/')
  })()`), '设置未显示主题预览图：' + name)
  await click(panel, name)
}

export async function compositionFlow(owner: BrowserWindow, child: BrowserWindow, other: BrowserWindow, panel: BrowserWindow, dir: string) {
  const provided = process.env.CAPTURE_THEME_BASE
  if (provided) {
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(readFileSync(provided))['theme.json']))
    await installPreview(panel, provided, manifest.name)
    await until(() => script(child, `document.documentElement.dataset.theme === ${JSON.stringify('external:' + manifest.id)}`), '小窗未采用外部样本主题')
    writeFileSync(join(dir, '主题卡片.png'), (await panel.webContents.capturePage()).toPNG())
  }
  const files = unzipSync(readFileSync(resolve('tests/fixtures/themes/celadon-mist.zip')))
  const base = JSON.parse(new TextDecoder().decode(files['theme.json']))
  const preview = 'images/preview.png'
  const fixture = { ...base, id: 'composition-trial', name: '装饰构图验收', formatVersion: 5, preview,
    decoration: { ...base.decoration, blurCards: true, wallpaper: 'images/grid.png', wallpaperFit: 'tile', wallpaperAnchor: 'bottom-right', wallpaperTileSize: 64,
      stickerAnchor: 'top-left', stickerOpacity: 45, stickerScale: 50 } }
  files[preview] = new Uint8Array((await owner.webContents.capturePage()).resize({ width: 480 }).toPNG())
  const grid = '<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" fill="#f3f6ee"/><path d="M0 32V0H32" fill="none" stroke="#bfcfc7"/></svg>'
  files['images/grid.png'] = new Uint8Array(await sharp(Buffer.from(grid)).png().toBuffer())
  files['theme.json'] = Buffer.from(JSON.stringify(fixture))
  const file = join(dir, 'composition.hytheme')
  writeFileSync(file, zipSync(files))
  await installPreview(panel, file, fixture.name)
  const windows = [owner, child]
  const defaults = async () => {
    for (const win of windows) await until(async () => {
      const s = await composition(win)
      return s.fit.split(' ')[0] === '64px' && s.repeat === 'repeat' && s.anchor === '100% 100%' &&
        s.corner === '0% 0%' && s.opacity === '0.45' && s.width > 0 && s.blurCards
    }, '窗口未采用主题包中的纹理和贴纸构图').catch(async cause => {
      throw new Error(win.getTitle() + ' 构图 ' + JSON.stringify(await composition(win)), { cause })
    })
  }
  await defaults()
  const widths = await Promise.all(windows.map(async win => (await composition(win)).width))
  await script(panel, `(() => {
    const details = document.querySelector('input[aria-label="贴纸大小"]').closest('details')
    if (!details.open) details.querySelector('summary').click()
  })()`)
  await script(panel, `document.querySelector('[aria-label="纹理宽度"]').focus()`)
  panel.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'})
  panel.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'})
  for (const win of windows) await until(async () => (await composition(win)).fit.startsWith('16px'), '平铺纹理宽度未同步')
  await script(panel, `document.querySelector('[aria-label="贴纸不透明度"]').focus()`)
  panel.webContents.sendInputEvent({type:'keyDown',keyCode:'End'})
  panel.webContents.sendInputEvent({type:'keyUp',keyCode:'End'})
  for (const win of windows) await until(async () => (await composition(win)).opacity === '1', '贴纸透明度未同步')
  const cardFilter = () => script(owner, `getComputedStyle(document.querySelector('[data-hy-part="resource-card"]')).backdropFilter`)
  assert.equal(await cardFilter(), 'blur(6px)')
  await script(panel, `document.querySelector('[role="switch"][aria-label="素材卡片毛玻璃"]').click()`)
  await until(async () => await cardFilter() === 'none' && !(await composition(child)).blurCards, '本库关闭卡片毛玻璃未生效')
  await choose(panel, '壁纸铺设', 'cover')
  await until(() => script(panel, `!document.querySelector('input[aria-label="纹理宽度"]')`), '铺满模式仍显示纹理宽度')
  await choose(panel, '壁纸锚点', 'top')
  await until(async () => (await composition(owner)).anchor === '50% 0%', '壁纸锚点未保存')
  await choose(panel, '贴纸位置', 'bottom-right')
  await until(async () => (await composition(child)).corner === '100% 100%', '贴纸换角未同步')
  await script(panel, `(() => {
    const input = document.querySelector('input[aria-label="贴纸大小"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'100')
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight'}))
  })()`)
  for (const [i, win] of windows.entries()) await until(async () => {
    const s = await composition(win)
    return s.fit === 'cover' && s.repeat === 'no-repeat' && s.anchor === '50% 0%' &&
      s.corner === '100% 100%' && Math.abs(s.width - widths[i] * 2) < 1
  }, '仓库单独设置未应用至工作台和小窗')
  assert.equal(await script(other, "document.documentElement.hasAttribute('data-hy-sticker')"), false)
  await click(panel, '恢复主题装饰')
  await defaults()
  assert.equal(await cardFilter(), 'blur(6px)')
  for (const [win, name] of [[owner, '构图-工作台'], [child, '构图-独立小窗']] as const) {
    writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
}
