import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nativeTheme, type BrowserWindow } from 'electron'
import { localThemes } from '../../src/main/appearance'
import { workbenchContentWindow, workbenchSessionWindows } from '../../src/main/auxiliary-windows'
import { callCore } from '../../src/main/core-client'
import { closeLibrary, libraryOf, openLibrary } from '../../src/main/libraries'
import { isWindowReady } from '../../src/main/page-lifecycle'
import { showLauncher } from '../../src/main/launcher'
import { executeUiCommand } from './capture-command'
import { findSettingsSurface } from './settings-surface'
import { compositionFlow } from './capture-theme-composition'
import { decorationFlow } from './capture-decoration'
import { button, click, pickTheme, script, until, themeFixture } from './theme-settings'

async function settings(owner: BrowserWindow, section: string, launcher = false) {
  if (!findSettingsSurface(owner)) await click(owner, launcher ? '应用与插件设置' : '打开设置')
  await until(() => !!findSettingsSurface(owner), '设置窗口没有打开')
  const win = findSettingsSurface(owner)!
  await click(win, section)
  return win
}

function contentWindow(owner: BrowserWindow) {
  const child = workbenchSessionWindows(owner).windows.find(w => w.id.startsWith('content:'))
  return child && workbenchContentWindow(owner, child.id)
}

async function detachReader(owner: BrowserWindow, title: string, choose: (label: string) => void) {
  const js = (s: string) => script(owner, s)
  await until(() => js('!!' + button('打开设置')), '仓库未就绪')
  const { core } = libraryOf(owner.webContents)!
  const { id } = await callCore(core, 'run', 'text', 'create', { content: title }) as { id: string }
  await executeUiCommand(js, 'host.view.all')
  const card = `document.querySelector('[data-hy-part="resource-card"][data-entity-id="${id}"]')`
  await until(() => js(`${card}?.innerText.includes(${JSON.stringify(title)})`), '文字卡片未显示')
  await js(`${card}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await until(() => js(`document.querySelector('[aria-label="阅读正文"]')?.innerText.includes(${JSON.stringify(title)})`), '未打开阅读页')
  choose('移到新窗口')
  await js(`document.querySelector('[role="tab"][data-tab][aria-selected="true"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  await until(() => !!contentWindow(owner), '阅读页未移窗')
  const child = contentWindow(owner)!
  await until(() => script(child, `document.querySelector('[aria-label="阅读正文"]')?.innerText.includes(${JSON.stringify(title)})`), '小窗正文不属于本库')
  return child
}

function appearance(win: BrowserWindow) {
  return script(win, `(() => {
    const root = document.documentElement, style = getComputedStyle(root)
    return { theme: root.dataset.theme, scheme: root.dataset.scheme, density: root.dataset.density, radius: root.dataset.radius,
      accent: style.getPropertyValue('--accent').trim(), paper: style.getPropertyValue('--paper').trim() }
  })()`)
}

async function expectAppearance(windows: BrowserWindow[], expected: Record<string, string>) {
  for (const win of windows) {
    await until(async () => {
      const current = await appearance(win)
      return Object.entries(expected).every(([key, value]) => current[key] === value)
    }, '外观未同步：' + win.getTitle() + ' ' + JSON.stringify(expected))
  }
}

async function expectSettingsTitlebar(owner: BrowserWindow, settings: BrowserWindow) {
  if (process.platform !== 'darwin') return
  assert.equal(settings.getContentBounds().y, settings.getBounds().y, '主题应绘制到窗口上沿')
  const base = await script(owner, "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()")
  await until(() => script(settings, `(() => {
    const header = document.querySelector('[role="dialog"] > header')
    const title = header?.querySelector('h1')?.getBoundingClientRect()
    const nav = document.querySelector('aside')?.getBoundingClientRect()
    if (!header || !title || !nav) return false
    const bar = header.getBoundingClientRect()
    const probe = document.createElement('span')
    probe.style.backgroundColor = ${JSON.stringify(base)}
    return Math.abs(innerHeight - ${settings.getBounds().height}) <= 1
      && bar.top === 0 && Math.abs(nav.top - bar.bottom) <= 1
      && Math.abs((title.left + title.right) / 2 - innerWidth / 2) <= 1
      && getComputedStyle(header).backgroundColor === probe.style.backgroundColor
      && getComputedStyle(header).webkitAppRegion === 'drag'
      && [...header.querySelectorAll('button')].every(b => getComputedStyle(b).webkitAppRegion === 'no-drag')
  })()`), '设置应只有一行居中标题，背景跟随所属窗口的基础色，下面直接进入设置导航')
}

export async function libraryThemesFlow(owner: BrowserWindow, dir: string, choose: (label: string) => void) {
  const stage = process.env.CAPTURE_FLOW!
  const resume = stage === 'theme-libraries-resume'
  const otherRoot = join(dir, '书房.library')
  let other = await openLibrary(otherRoot, { show: true })
  if (stage === 'theme-cycle' || stage === 'theme-cycle-resume') {
    const launcher = showLauncher(true)
    const previous = nativeTheme.themeSource
    try {
      nativeTheme.themeSource = 'dark'
      const panel = await settings(launcher, '外观与主题', true)
      const inDay = { theme: 'external:cyanotype', scheme: 'light', accent: '#1D4F91' }
      const atNight = { theme: 'external:cyanotype', scheme: 'dark', accent: '#A9D2F5' }
      if (stage === 'theme-cycle-resume') {
        await expectAppearance([owner, launcher], atNight)
        await expectAppearance([other.win], inDay)
        await click(panel, '移除主题：蓝晒')
        await expectAppearance([owner, other.win, launcher, panel], { theme: 'huoye-standard' })
      } else {
        const child = await detachReader(owner, '窗前读书', choose)
        const followers = [owner, child, launcher, panel]
        await pickTheme(panel, resolve('examples/themes/ginkgo.hytheme'))
        await click(panel, '银杏·秋光')
        await expectAppearance([...followers, other.win], { theme: 'external:ginkgo', scheme: 'dark', accent: '#EDB548' })
        nativeTheme.themeSource = 'light'
        await expectAppearance(followers, { theme: 'external:ginkgo', scheme: 'light', accent: '#94640F' })
        await click(panel, '移除主题：银杏·秋光')
        await expectAppearance(followers, { theme: 'huoye-standard' })
        nativeTheme.themeSource = 'dark'
        await pickTheme(panel, resolve('examples/themes/cyanotype.hytheme'))
        await click(panel, '蓝晒')
        await expectAppearance([...followers, other.win], atNight)
        const book = await settings(other.win, '本库外观')
        await click(book, '单独设置')
        await click(book, '固定浅色')
        await expectAppearance([other.win, book], inDay)
        await expectSettingsTitlebar(launcher, panel)
        await expectSettingsTitlebar(other.win, book)
        const revision = localThemes().snapshot().revision
        nativeTheme.themeSource = 'light'
        await expectAppearance(followers, inDay)
        await expectSettingsTitlebar(launcher, panel)
        nativeTheme.themeSource = 'dark'
        await expectAppearance(followers, atNight)
        await expectAppearance([other.win, book], inDay)
        assert.equal(localThemes().snapshot().revision, revision, '自动跟随系统不应写入偏好')
        await click(panel, '固定深色')
        nativeTheme.themeSource = 'light'
        await until(() => !nativeTheme.shouldUseDarkColors, '系统明暗未更新')
        await expectAppearance(followers, atNight)
        await click(panel, '跟随系统')
        await expectAppearance(followers, inDay)
      }
      writeFileSync(join(dir, stage + '-result.json'), JSON.stringify({ passed: true }))
    } finally { nativeTheme.themeSource = previous }
    return
  }
  if (stage === 'theme-composition') {
    const child = await detachReader(owner, '工作台构图与独立阅读窗', choose)
    const panel = await settings(owner, '本库外观')
    await click(panel, '单独设置')
    await compositionFlow(owner, child, other.win, panel, dir)
    writeFileSync(join(dir, 'theme-composition-result.json'), JSON.stringify({ main: true, detached: true, restored: true }))
    return
  }
  if (stage === 'theme-decoration') {
    const child = await detachReader(owner, '检查装饰后的正文拖选和键盘焦点', choose)
    await decorationFlow(owner, child, other.win, dir, choose, () => settings(owner, '本库外观'))
    return
  }
  const launcher = showLauncher(true)
  const sample = themeFixture(dir, 'letterpress-album.json')
  const expectedFile = join(dir, 'theme-libraries-result.json')
  if (!resume) {
    const legacy = JSON.parse(readFileSync(sample, 'utf8'))
    const prefs = { presetId: 'external:' + legacy.id, density: 'compact', radius: 'soft',
      previousBuiltin: { presetId: 'obsidian', density: 'comfortable', radius: 'rounded' } }
    const entries = { ['huoye:theme-package:v1:' + legacy.id]: legacy, 'rm:theme-preferences:v1': prefs,
      ['huoye:library-appearance:v1:' + other.id]: { presetId: 'warm-paper', density: 'compact', radius: 'sharp' } }
    await until(() => script(launcher, '!!' + button('应用与插件设置')), '开始页尚未初始化')
    await script(launcher, `Object.entries(${JSON.stringify(entries)}).forEach(([key,value]) => localStorage.setItem(key,JSON.stringify(value)))`)
    await script(launcher, `localStorage.setItem('huoye:theme-package:v1:unfinished', '{')`)
    const loaded = new Promise<void>(resolve => launcher.webContents.once('did-finish-load', () => resolve()))
    launcher.webContents.reload()
    await loaded
    await expectAppearance([owner, launcher], { theme: prefs.presetId, density: 'compact', radius: 'soft' })
    await expectAppearance([other.win], { theme: 'warm-paper' })
    assert(await script(launcher, `${JSON.stringify(Object.keys(entries))}.every(key => localStorage.getItem(key) === null)`))
    assert.equal(await script(launcher, `localStorage.getItem('huoye:theme-package:v1:unfinished')`), '{', '无效旧包应留在原处')
    const global = await settings(launcher, '外观与主题', true)
    await click(global, '还原内置外观')
    const local = await settings(other.win, '本库外观')
    await click(local, '恢复跟随应用')
    await expectAppearance([owner, other.win, launcher], { theme: 'obsidian' })
    await click(local, '关闭设置')
    await until(() => !findSettingsSurface(other.win), '本库外观窗口未关闭')
    await click(global, '移除主题：活字画册')
  }
  const app = await settings(launcher, '外观与主题', true)
  assert(!await script(app, '!!' + button('本库外观')), '开始页显示了仓库专属设置')
  if (resume) {
    const { local, shared } = JSON.parse(readFileSync(expectedFile, 'utf8'))
    await expectAppearance([owner, launcher], shared)
    await expectAppearance([other.win], { theme: 'external:letterpress-album' })
    // 在书房关闭时移除并重装同名包；下次打开仍恢复书房原先的内置外观。
    await until(() => isWindowReady(other.win), '书房工作台未完成启动')
    await closeLibrary(other)
    await click(app, '移除主题：活字画册')
    await until(() => script(app, '!' + button('活字画册')), '移除未完成')
    await pickTheme(app, sample)
    await until(() => script(app, '!!' + button('活字画册')), '主题未重新安装')
    other = await openLibrary(otherRoot, { show: true })
    await expectAppearance([other.win], local)
    const book = await settings(other.win, '本库外观')
    await click(book, '恢复跟随应用')
    await expectAppearance([other.win, book], shared)
    await click(app, '活字画册')
    await expectAppearance([owner, other.win, book, launcher], { theme: 'external:letterpress-album' })
    writeFileSync(join(dir, stage + '-result.json'), JSON.stringify({ restored: local, following: shared }))
    return
  }

  const firstChild = await detachReader(owner, '视觉索引', choose)
  const bookChild = await detachReader(other.win, '书房目录', choose)
  const book = await settings(other.win, '本库外观')
  await click(book, '单独设置')
  await click(book, '青瓷书房')
  await click(book, '紧凑')
  await click(book, '利落')
  await click(book, '强调色：琥珀金')
  await script(book, `(() => {
    const panel = document.querySelector('section[aria-label="本库外观"]')
    Array.from(panel.querySelectorAll('summary')).find(el => el.textContent.includes('高级表面色彩微调')).click()
    const field = [...panel.querySelectorAll('label')].find(l => l.textContent.includes('阅读纸张')).querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '#faf3d7')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const local = { theme: 'celadon-reading', density: 'compact', radius: 'sharp', accent: '#e59934', paper: '#faf3d7' }
  await expectAppearance([other.win, bookChild, book], local)
  await expectAppearance([owner, firstChild, launcher], { theme: 'obsidian' })
  const visual = await settings(owner, '本库外观')
  await click(visual, '单独设置')
  await script(visual, "document.querySelector('.theme-classics:not([open]) > summary')?.click()")
  await click(visual, '冷灰石墨')
  await expectAppearance([owner, firstChild, visual], { theme: 'graphite' })
  await script(app, "document.querySelector('.theme-classics:not([open]) > summary')?.click()")
  await click(app, '松烟墨绿')
  await click(app, '强调色：靛青紫')
  await expectAppearance([launcher], { theme: 'pine', accent: '#7c6aff' })
  const shared = await appearance(launcher)
  assert.equal(shared.theme, 'pine')
  assert.equal(shared.accent, '#7c6aff')
  await expectAppearance([owner, firstChild, visual], { theme: 'graphite' })
  await click(visual, '恢复跟随应用')
  await expectAppearance([owner, firstChild, visual, app], shared)
  await expectAppearance([other.win, bookChild, book], local)
  for (const [win, name] of [[firstChild, '视觉库小窗'], [bookChild, '书房小窗'], [book, '本库设置']] as const) {
    writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await pickTheme(book, sample)
  await click(book, '活字画册')
  await expectAppearance([other.win, bookChild], { theme: 'external:letterpress-album' })
  await click(book, '还原内置外观')
  await expectAppearance([other.win, bookChild], local)
  await click(book, '活字画册')
  await expectAppearance([other.win, bookChild], { theme: 'external:letterpress-album' })
  writeFileSync(expectedFile, JSON.stringify({ local, shared }))
}
