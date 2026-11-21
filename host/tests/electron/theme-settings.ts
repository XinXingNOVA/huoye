import { copyFileSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { findSettingsSurface, settingsScript } from './settings-surface'

export function themeFixture(dir: string, file: string) {
  const path = join(dir, parse(file).name + '.hytheme')
  copyFileSync(resolve('tests/fixtures/themes', file), path)
  return path
}

export async function script(win: BrowserWindow, code: string) {
  try { return await win.webContents.executeJavaScript(code, true) }
  catch (cause) { throw new Error('主题验收脚本执行失败：' + code, { cause }) }
}
export async function until(test: () => Promise<unknown> | unknown, label: string) {
  for (let i = 0; i < 120; i++) {
    if (await test()) return
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(label)
}
export const button = (label: string) => `[...document.querySelectorAll('button')].find(b =>
  (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(label)} && b.checkVisibility())`
export async function click(win: BrowserWindow, label: string) {
  await until(() => script(win, `(() => {
    const target = ${button(label)}
    if (!target || target.disabled) return false
    target.click()
    return true
  })()`), '按钮未就绪：' + label)
}

// 点击生产安装按钮；在 Chromium 文件选择器边界交付磁盘上的文件。
export async function pickTheme(settings: BrowserWindow, path: string, label = '安装主题包…') {
  const dbg = settings.webContents.debugger
  let node: number | undefined
  const opened = (_: Electron.Event, method: string, params: { backendNodeId?: number }) => {
    if (method === 'Page.fileChooserOpened') node = params.backendNodeId
  }
  dbg.attach()
  dbg.on('message', opened)
  try {
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    await click(settings, label)
    await until(() => !!node, '安装入口没有打开文件选择器')
    await dbg.sendCommand('DOM.setFileInputFiles', { backendNodeId: node, files: [path] })
  } finally {
    dbg.off('message', opened)
    dbg.detach()
  }
}

export async function openThemeSettings(owner: BrowserWindow) {
  await script(owner, `document.querySelector('[aria-label="打开设置"]').click()`)
  await until(() => !!findSettingsSurface(owner), '设置窗口未打开')
  await until(() => settingsScript(owner, `(() => {
    const tab = ${button('外观与主题')}
    if (tab) tab.click()
    return !!tab
  })()`), '外观设置不可用')
  return findSettingsSurface(owner)!
}
