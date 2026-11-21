import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { until } from './theme-settings'
import { findSettingsSurface, settingsScript } from './settings-surface'
import { showLauncher } from '../../src/main/launcher'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'

export async function directoryMaintenanceFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!, root = join(dir, '登记维护样本')
  const file = join(root, '原文.md'), outside = join(dir, '移出的原文.md')
  mkdirSync(root); writeFileSync(file, '独立原件')
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const settings = (code: string) => settingsScript(win, code)
  const click = (surface: typeof js, label: string, selector = 'button') => until(() => surface(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.checkVisibility() && !el.disabled &&
      (el.textContent.trim() === ${JSON.stringify(label)} || el.getAttribute('aria-label') === ${JSON.stringify(label)}))
    if (!b) return false
    b.click(); return true
  })()`), '无法点击 ' + label)
  const picker = dialog.showOpenDialog
  let space: { id: string }
  try {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof picker
    space = await js('window.bridge.spaces.directories.pick()')
  } finally { dialog.showOpenDialog = picker }
  const sid = JSON.stringify(space.id), scan = () => js('window.bridge.spaces.directories.refreshTree(' + sid + ')')
  await scan()
  const plan = await callCore(lib.core, 'previewDirectoryCollection', space.id, ['md'])
  await callCore(lib.core, 'collectDirectoryFiles', space.id, ['md'], plan.token)
  const [id] = (await callCore(lib.core, 'query', { has:['file'] })).ids
  assert.ok(id)
  renameSync(file, outside); await scan()
  await click(js, '打开设置')
  await until(() => !!findSettingsSurface(win), '设置未打开')
  await click(settings, '文件空间与外部应用', '.application-settings-nav button')
  const panel = "document.querySelector('[aria-label=本机原地目录登记簿]')"
  await until(() => settings(panel + "?.querySelector('summary')?.textContent.includes('登记维护样本')"), '设置中未发现登记簿')
  await settings(panel + ".querySelector('summary').click()")
  await settings(panel + ".querySelector('select').value='0'; " + panel + ".querySelector('select').dispatchEvent(new Event('change',{bubbles:true}))")
  await click(settings, '预览清理缺失记录…')
  await until(() => settings(panel + "?.querySelector('[role=group]')?.textContent.includes('原文.md')"), '清理预览缺失')
  await click(settings, '确认清理缺失记录')
  await until(() => settings(panel + "?.textContent.includes('已清理 1 条')"), '缺失记录未清理')
  assert.deepEqual((await callCore(lib.core, 'query', { has:['file'] })).ids,[id])
  await js('window.bridge.spaces.directories.unlink(' + sid + ',{active:1,trashed:0})')
  const launcher = showLauncher(false)
  await click(code => launcher.webContents.executeJavaScript(code), '设置')
  await until(() => !!findSettingsSurface(launcher), '开始页设置未打开')
  const globalSettings = (code: string) => settingsScript(launcher, code)
  await click(globalSettings, '文件空间与外部应用', '.application-settings-nav button')
  await until(() => globalSettings(panel + "?.querySelector('summary')?.textContent.includes('0 个仓库')"), '开始页未显示无成员登记簿')
  await globalSettings(panel + ".querySelector('summary').click()")
  await click(globalSettings, '忘记本机登记簿…'); await click(globalSettings, '取消')
  await click(globalSettings, '忘记本机登记簿…'); await click(globalSettings, '确认忘记登记簿')
  await until(() => globalSettings(panel + "?.textContent.includes('本机没有原地目录登记簿')"), '登记簿未清理')
  assert.equal(readFileSync(outside, 'utf8'), '独立原件')
  assert.deepEqual((await callCore(lib.core, 'query', { has:['file'] })).ids,[id])
  writeFileSync(join(dir,'directorymaintenance-result.json'), JSON.stringify({ ok: true }))
}
