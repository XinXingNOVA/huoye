import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { libraryOf, openLibrary, reloadLibrary, allClosed } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { developmentDirectories, developmentPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import type { DevelopmentDirectoryState } from '../../src/shared/external-plugins'

export async function developmentDirectoryFlow(win: BrowserWindow, dir: string) {
  const lib = () => libraryOf(win.webContents)!
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn: () => Promise<unknown>, label: string) => {
    for (let i = 0; i < 600; i++) { try { if (await fn()) return } catch { /* 重载时等待新页面。 */ } await wait(100) }
    throw new Error(label)
  }
  const click = (text: string, selector = 'button') => until(() => js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.scrollIntoView({block:'center'});b.click();return true})()`), '无法点击 ' + text)
  const settings = async () => { win.webContents.send('menu:command', 'settings'); await until(() => js("!!document.querySelector('[data-development-directory]')"), '开发区未出现') }
  const title = (text: string) => until(() => js(`document.querySelector('.demo-reviewmemo h2')?.textContent.includes(${JSON.stringify(text)})`), '界面未更新：' + text)
  const state = (): Promise<DevelopmentDirectoryState> => js('window.bridge.packages.developmentDirectory()')
  const checkbox = (id: string) => until(() => js(`(()=>{const e=document.querySelector('[data-development-source="${id}"] input[type=checkbox]');if(!e||e.disabled)return false;e.scrollIntoView({block:'center'});e.click();return true})()`), '不能勾选 ' + id)
  const apply = async (selector = '[data-development-directory] button') => { await click('应用并重载', selector); await wait(300); await settings() }
  const shot = async (name: string) => { await js("document.querySelector('[data-development-directory]')?.scrollIntoView({block:'start'})"); writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  try {
    await settings()
    if (process.env.CAPTURE_FLOW === 'developmentdirectoryresume') {
      const saved = JSON.parse(readFileSync(join(dir, 'developmentdirectory-state.json'), 'utf8'))
      await title('目录开发二')
      assert.equal(developmentPackages().links(lib().root)[0].hash, saved.hash)
      await until(async () => (await state()).rows.some(r => r.appliedHash && r.availableHash && r.availableHash !== r.appliedHash), '重启后没有发现源码更新')
      await apply('.development-notices button'); await title('目录开发三')
      assert.equal((await callCore(lib().core, 'readContent', { id: saved.id, kind: 'demo-reviewmemo', field: 'text' })).text, '目录模式保留数据')
      await click('移除全部目录并退出开发'); await wait(300); await settings(); await title('独立插件验证')
      assert.equal((await state()).directory, undefined)
      assert.equal(developmentPackages().links(lib().root).length, 0)
      assert.equal((await callCore(lib().core, 'externalPlugins')).find(p => p.manifest.id === 'demo-reviewmemo')?.hash, saved.releaseHash)
      assert.equal((await callCore(lib().core, 'readContent', { id: saved.id, kind: 'demo-reviewmemo', field: 'text' })).text, '目录模式保留数据')
      await shot('development-directory-exit')
      writeFileSync(join(dir, 'developmentdirectoryresume-result.json'), JSON.stringify({ ok: true, checks: ['重启保留快照', '离线变化待确认', '快捷应用', '退出恢复正式版本', '数据保留'] }))
      return
    }
    selectCapturePackage(join(dir, 'formal.rmplugin'))
    const preview = await js('window.bridge.packages.pick()')
    await js(`window.bridge.packages.install(${JSON.stringify(preview.token)})`)
    const disabled = (await callCore(lib().core, 'plugins')).filter(p => !p.external && p.chosen).map(p => p.id)
    await js(`window.bridge.packages.apply(${JSON.stringify({ disabled, changes: [{ hash: preview.items[0].hash, enabled: true }] })})`)
    await reloadLibrary(lib()); await settings(); await title('独立插件验证')
    const id = await callCore(lib().core, 'create', { 'demo-reviewmemo': { text: '目录模式保留数据' } })
    const directory = join(dir, 'sources'), source = join(directory, 'demo')
    selectCapturePackage(directory); await click('选择开发目录…')
    await until(async () => (await state()).rows.length === 2, '没有发现两项插件')
    selectCapturePackage(source); await click('添加目录…')
    await until(async () => (await state()).directories?.length === 2, '第二个来源未加入')
    assert.equal((await state()).rows.length, 2, '重叠来源重复展示插件')
    await js(`(()=>{const row=[...document.querySelectorAll('.development-folder')].find(e=>e.textContent.includes(${JSON.stringify(source)}));row.querySelector('button').click()})()`)
    await until(async () => (await state()).directories?.length === 1, '单独来源未移除')
    assert.equal((await state()).rows.length, 2)
    assert((await state()).rows.every(r => !r.appliedHash))
    await checkbox('demo-reviewmemo'); await checkbox('demo-other')
    await until(async () => (await state()).rows.every(r => r.availableHash && r.build?.state === 'ready'), '开发工具自动构建失败')
    await shot('development-directory-ready')
    await apply(); await title('目录开发一')
    assert.equal(await js("document.querySelectorAll('.plugin-catalog [data-plugin-id=demo-reviewmemo]').length"), 0)
    assert(!(await js('window.bridge.packages.installed()')).some((p: any) => p.manifest.id === 'demo-other'))
    assert.equal((await callCore(lib().core, 'externalPlugins')).find(p => p.manifest.id === 'demo-reviewmemo')?.hash, preview.items[0].hash)
    const firstHash = developmentPackages().links(lib().root).find(p => p.manifest.id === 'demo-reviewmemo')!.hash
    const original = join(dir, '开发目录中新导入.png')
    await sharp({ create: { width: 240, height: 180, channels: 3, background: '#42839a' } }).png().toFile(original)
    const [fileId] = await callCore(lib().core, 'ingest', [{ type: 'file', path: original }])
    await until(async () => { const view = (await callCore(lib().core, 'get', [fileId]))[0]; return view.blocks.thumb && !Object.keys(view.failures).length }, '新文件没有通过实际核心加工')

    const other = await openLibrary(join(dir, 'B.library'), { show: false })
    try {
      assert.equal(developmentDirectories().state(other.root).directory, undefined)
      await developmentDirectories().setDirectory(other.root, directory)
      await developmentDirectories().prepare(other.root, [source])
      await until(async () => !!developmentDirectories().state(other.root).rows.find(r => r.source === source)?.availableHash, 'B 构建失败')
      developmentDirectories().apply(other.root, [{ source, hash: developmentDirectories().state(other.root).rows.find(r => r.source === source)!.availableHash! }])
      await reloadLibrary(other)
      const otherHash = other.packages.find(p => p.development)!.hash
      const ui = join(source, 'ui.tsx'), first = readFileSync(ui, 'utf8'), second = first.replace('目录开发一', '目录开发二')
      writeFileSync(ui, second)
      await until(async () => (await state()).rows.some(r => r.id === 'demo-reviewmemo' && r.availableHash && r.availableHash !== firstHash), '源码变化没有构建')
      assert.equal(developmentPackages().links(lib().root).find(p => p.manifest.id === 'demo-reviewmemo')!.hash, firstHash)
      await apply('.development-notices button'); await title('目录开发二')
      assert.equal(other.packages.find(p => p.development)!.hash, otherHash, 'A 应用影响了 B')
      writeFileSync(ui, second + '\nconst invalid: number = "broken"\n')
      await until(async () => (await state()).rows.some(r => r.id === 'demo-reviewmemo' && r.build?.state === 'error'), '类型错误未显示')
      await title('目录开发二')
      await until(() => js("!!document.querySelector('.development-diagnostics')"), '没有错误详情')
      await js("document.querySelector('.development-diagnostics').open=true"); await shot('development-directory-error')
      writeFileSync(ui, second)
      await until(async () => (await state()).rows.some(r => r.id === 'demo-reviewmemo' && r.build?.state === 'ready'), '修复后未构建')
    } finally { other.win.close(); await until(async () => other.win.isDestroyed(), 'B 未关闭'); await allClosed() }

    rmSync(join(directory, 'other'), { recursive: true })
    await until(async () => (await state()).rows.some(r => r.id === 'demo-other' && r.problem), '移除源码未发现')
    await checkbox('demo-other'); await apply(); await title('目录开发二')
    const added = join(directory, 'new'); mkdirSync(added)
    writeFileSync(join(added, 'plugin.json'), JSON.stringify({ id: 'demo-new', title: '新发现的插件', description: '', author: 'test', version: '1.0.0', apiVersion: 1, entries: { ui: './ui.tsx' } }))
    writeFileSync(join(added, 'ui.tsx'), "export const plugin={id:'demo-new'}")
    await until(async () => (await state()).rows.some(r => r.id === 'demo-new' && !r.appliedHash), '新增插件没有自动出现')
    await until(() => js("!!document.querySelector('[data-development-source=demo-new]')"), '新增插件没有出现在实际列表')
    win.setSize(980, 760); await shot('development-directory-narrow')
    assert(await js("(()=>{const e=document.querySelector('[data-development-directory]');return e.scrollWidth<=e.clientWidth})()"), '开发区窄窗溢出')
    const hash = developmentPackages().links(lib().root)[0].hash
    writeFileSync(join(dir, 'developmentdirectory-state.json'), JSON.stringify({ id, hash, releaseHash: preview.items[0].hash }))
    writeFileSync(join(dir, 'developmentdirectory-result.json'), JSON.stringify({ ok: true, checks: ['多来源添加与移除', '重叠目录去重', '目录发现', '批量启用', '真实新文件加工', '双库独立应用', '错误恢复', '源码移除后退出', '新增默认不启用', '窄窗'] }))
  } catch (error) {
    writeFileSync(join(dir, 'developmentdirectory-error.txt'), String(error) + '\n' + await js('document.body.innerText').catch(() => ''))
    writeFileSync(join(dir, 'developmentdirectory-error.png'), (await win.webContents.capturePage()).toPNG())
    throw error
  }
}
