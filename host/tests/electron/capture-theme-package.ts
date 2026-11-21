import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { showLauncher } from '../../src/main/launcher'
import { script, until, click, button, pickTheme } from './theme-settings'

function appearance(win: BrowserWindow) {
  return script(win, `(() => {
    const root=document.documentElement, style=getComputedStyle(root)
    return { theme:root.dataset.theme, density:root.dataset.density, radius:root.dataset.radius,
      background:getComputedStyle(document.body).backgroundColor, accent:style.getPropertyValue('--accent').trim(),
      inset:style.getPropertyValue('--hy-panel-inset').trim(), font:style.getPropertyValue('--hy-reading-font').trim() }
  })()`)
}

export async function checkThemePackage(owner: BrowserWindow, child: BrowserWindow, reader: BrowserWindow, dir: string, openAppearance: () => Promise<BrowserWindow>) {
  const sample = resolve('tests/fixtures/themes/night-bookshop.json')
  const packaged = JSON.parse(readFileSync(sample, 'utf8'))
  const file = join(dir, '书店.hytheme')
  const image = (await owner.webContents.capturePage()).resize({ width: 8, height: 8 }).toPNG()
  writeFileSync(file, zipSync({ 'theme.json': readFileSync(sample), 'images/cover.png': image }))
  const settings = await openAppearance()
  await click(settings, '强调色：琥珀金')
  await click(settings, '柔和')
  await until(async () => (await appearance(owner)).radius === 'soft' && (await appearance(owner)).accent === '#e59934', '基准外观未同步')
  const baseline = await appearance(owner)
  assert.equal(baseline.accent, '#e59934')
  await until(async () => (await appearance(child)).accent === baseline.accent, '小窗基准外观未就绪')
  await pickTheme(settings, file)
  await until(() => script(settings, '!!' + button(packaged.name)), '安装完成后列表没有主题')
  assert.deepEqual(await appearance(owner), baseline, '仅安装即覆盖当前外观')
  await click(settings, packaged.name)
  const themed = 'external:' + packaged.id
  for (const win of [owner, child, settings]) {
    await until(async () => (await appearance(win)).theme === themed, '窗口未切换外部主题')
    const state = await appearance(win)
    assert.equal(state.accent, packaged.colors.accent)
    assert.equal(state.density, 'comfortable')
    assert.equal(state.inset, '8px')
    assert.equal(state.background, 'rgb(34, 27, 28)')
  }
  const url = await script(owner, `window.bridge.appearance.load().then(s => s.installed.find(p => p.id === ${JSON.stringify(themed)}).images['images/cover.png'])`)
  const loadImage = () => script(child, `new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = ${JSON.stringify(url)} })`)
  assert.equal(await loadImage(), 8, '小窗未能读取受管 PNG')
  const paper = await script(reader, `getComputedStyle(document.querySelector('[role="article"][aria-label="阅读正文"]')).backgroundColor`)
  assert.equal(paper, 'rgb(244, 230, 207)')
  for (const [win, name] of [[settings, 'settings'], [owner, 'main'], [child, 'child']] as const) {
    writeFileSync(join(dir, 'theme-package-' + name + '.png'), (await win.webContents.capturePage()).toPNG())
  }

  // 原文件移走后，另一个全新渲染进程应直接显示已安装主题。
  unlinkSync(file)
  const launcher = showLauncher(false)
  await until(async () => (await appearance(launcher)).theme === themed, '新窗口没有从本机恢复外部主题')

  // 更新失败应保留已装的有效包及当前外观。
  writeFileSync(file, JSON.stringify({ ...packaged, colors: { accent: 'invalid' } }))
  await pickTheme(settings, file)
  await until(() => script(settings, `document.querySelector('[role="alert"]')?.textContent.includes('colors.accent')`), '缺少校验失败反馈')
  assert.equal((await appearance(owner)).accent, packaged.colors.accent)

  await click(settings, '还原内置外观')
  for (const win of [owner, child, launcher]) {
    await until(async () => (await appearance(win)).theme === baseline.theme, '窗口未还原')
    assert.deepEqual(await appearance(win), baseline)
  }
  assert(await script(settings, '!!' + button(packaged.name)), '还原后已安装主题丢失')
  await click(settings, packaged.name)
  writeFileSync(file, JSON.stringify({ ...packaged, colors: { ...packaged.colors, accent: '#DCAAA4' } }))
  await pickTheme(settings, file)
  for (const win of [owner, child, launcher]) {
    await until(async () => (await appearance(win)).accent === '#DCAAA4', '重新安装后仍在使用旧主题')
  }
  assert.equal(await script(settings, `document.querySelectorAll('button[aria-label="夜航书店"]').length`), 1)
  await click(settings, '移除主题：' + packaged.name)
  await until(() => script(settings, '!' + button(packaged.name)), '移除后主题仍在列表')
  await until(async () => (await appearance(child)).theme === baseline.theme, '移除正在使用的主题没有自动还原')
}
