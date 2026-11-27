import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { settingsScope, finishPackageInstall } from './capture-settings'
import { findSettingsSurface, settingsScript, settingsSurface } from './settings-surface'
import { localPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import { callCore } from '../../src/main/core-client'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import type { PackagePreview } from '../../src/shared/external-plugins'

async function until(label: string, check: () => unknown) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw Error(label)
}

export async function nativeEnginesFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const ready = () => until('工作台未就绪', () => js("!!document.querySelector('[aria-label=打开设置]')").catch(() => false))
  await ready()
  const files = ['comic-test.hyplugin', 'comic-native.hyplugin'].map(f => join(dir, f))
  const preview: PackagePreview = await js('window.bridge.packages.previewFiles(' + JSON.stringify(files) + ')')
  await js('window.bridge.packages.install(' + JSON.stringify(preview.token) + ')')
  const disabled = (await callCore(lib.core, 'plugins')).filter(p => !p.external && p.chosen).map(p => p.id)
  const enable = async (enabled: boolean) => {
    const changes = preview.items.map(p => ({ hash: p.hash, enabled: p.manifest?.id === 'comic-test' || enabled }))
    await js('window.bridge.packages.apply(' + JSON.stringify({ disabled, changes }) + ')')
    await Promise.all([once(win.webContents, 'did-finish-load', { signal: AbortSignal.timeout(20000) }), reloadLibrary(lib)])
    await ready()
  }
  const routes = async () => (await callCore(lib.core, 'info')).capabilities.filter(c => c.id.startsWith('sample/comic.'))
  const ingest = async (name: string) => (await callCore(lib.core, 'ingest', [{ type: 'file', path: join(dir, name + '.cbz') }]))[0]
  const entity = async (id: string) => (await callCore(lib.core, 'get', [id]))[0]
  await enable(true)
  assert.deepEqual((await routes()).map(r => [r.state, r.provider]), [['ready', 'comic-native'], ['ready', 'comic-native']])
  const cancelled = await ingest('cancel')
  const pidFile = join(dir, 'native.pid')
  await until('原生加工未启动', async () => {
    assert.deepEqual((await entity(cancelled)).failures, {})
    return existsSync(pidFile) && Number(readFileSync(pidFile)) > 1
  })
  const pid = Number(readFileSync(pidFile))
  await callCore(lib.core, 'trash', [cancelled])
  await until('原生进程未随加工撤销', () => {
    try { process.kill(pid, 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' }
  })
  const id = await ingest('sample')
  const kind = 'comic-test.page'
  await until('漫画未完成出图', async () => {
    const item = await entity(id)
    assert.deepEqual(item.failures, {})
    return !!item.blocks[kind]
  })
  const result = (await entity(id)).blocks[kind].data
  assert.deepEqual(result.pages, [{ index: 0, name: '001.png' }, { index: 1, name: '002.png' }])
  assert.match(String(result.path), /^cache\/provider-images\/[a-f0-9]{64}\.png$/)
  const cached = join(lib.root, String(result.path))
  const image = readFileSync(cached)
  assert(image.length > 4 * 1024 * 1024)
  assert(image.equals(readFileSync(join(dir, '002.png'))))
  const bad = await ingest('broken')
  await until('引擎错误没有带回稳定错误码', async () => Object.values((await entity(bad)).failures).some(error => error.startsWith('[COMIC_INVALID_PAGE]')))
  const replace = async (name: string) => {
    const edit = await callCore(lib.core, 'prepareFileEdit', { id, destination: { mode: 'publish' },
      content: { type: 'file', path: join(dir, name + '.cbz') }, requestId: randomUUID() })
    const saved = await callCore(lib.core, 'commitFileEdit', { editId: edit.editId, previewToken: edit.previewToken, requestId: randomUUID() })
    assert.equal(saved.library.state, 'accepted')
  }
  await replace('empty')
  await until('撤下的派生页未清理', async () => !(await entity(id)).blocks[kind] && !existsSync(cached))
  await replace('sample')
  await until('重新取页未恢复', async () => !!(await entity(id)).blocks[kind] && existsSync(cached))
  const hash = preview.items.find(p => p.manifest?.id === 'comic-native')!.hash
  assert(hash)
  const uninstall = () => js('window.bridge.packages.uninstall(' + JSON.stringify(hash) + ')')
  await assert.rejects(uninstall(), /受以下绑定或任务保护/)
  await enable(false)
  assert((await routes()).every(r => r.state === 'unavailable'))
  await uninstall()
  assert(!existsSync(localPackages().directory(hash)))
  const waiting = await ingest('resume')
  assert(!(await entity(waiting)).blocks[kind])
  win.webContents.send('menu:command', 'settings')
  await until('设置未打开', () => !!findSettingsSurface(win))
  const settings = (code: string) => settingsScript(win, code)
  await settingsScope(settings, 'application')
  selectCapturePackage(files[1])
  await until('安装入口不可用', () => settings(`(() => {
    const b = [...document.querySelectorAll('.package-settings button')].find(b => b.textContent === '安装套件或插件包…')
    if (!b || b.disabled) return false
    b.click(); return true
  })()`))
  await until('安装预览未显示随包程序', () => settings(`(() => {
    const details = document.querySelector('[data-install-status=ready] .package-install-meta')
    if (!details) return false
    details.open = true
    return details.innerText.includes('huoye-test-unpack') && details.innerText.includes(${JSON.stringify(process.platform + '-' + process.arch)})
  })()`))
  await finishPackageInstall(settings, false)
  settingsSurface(win).close()
  await enable(true)
  assert((await routes()).every(r => r.state === 'ready' && r.provider === 'comic-native'))
  await until('重装引擎后已有素材未完成取页', async () => !!(await entity(waiting)).blocks[kind])
  const resumed = (await entity(waiting)).blocks[kind].data
  assert(readFileSync(join(lib.root, String(resumed.path))).equals(readFileSync(join(dir, '001.png'))))
  await callCore(lib.core, 'trash', [id])
  const purge = await callCore(lib.core, 'purge', [id])
  assert.equal(purge.purged, 1)
  assert(!existsSync(cached))
  assert(existsSync(join(dir, 'sample.cbz')))
  writeFileSync(join(dir, 'native-engines.json'), JSON.stringify({ pages: result.pages, bytes: image.length, cancelledPid: pid, purged: true,
    target: process.platform + '-' + process.arch, engineRemoved: true, resumedAfterReinstall: true }, null, 2))
}
