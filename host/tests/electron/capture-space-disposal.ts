import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { openLibraries, openLibrary, allClosed } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { FileSpace } from '../../src/storage/file-space'

/** 只处置此流程新建临时空间中的文件包；实际调用系统废纸篓，精确取回本次包，不清空废纸篓。 */
export async function spaceDisposalFlow(win: BrowserWindow, dir: string) {
  const a = openLibraries().find(l => l.win === win)!
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const until = async (fn: () => Promise<unknown>, label: string) => {
    for (let i = 0; i < 250; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
    writeFileSync(join(dir, 'disposal-error.txt'), await js('document.body.innerText')); throw new Error(label)
  }
  const click = (label: string, selector = 'button,.nav-item') => until(() => js("(()=>{const e=[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find(e=>e.checkVisibility()&&e.textContent.trim()===" + JSON.stringify(label) + ");if(!e||e.disabled)return false;e.click();return true})()"), '不能点击 ' + label)
  const choose = () => until(() => js("(()=>{const e=[...document.querySelectorAll('.space-file')].find(e=>e.checkVisibility()&&e.textContent.includes('处置验收.png'))?.querySelector('input');if(!e||e.disabled)return false;if(!e.checked)e.click();return true})()"), '不能选择文件')
  const shot = async (name: string) => { await new Promise(r => setTimeout(r, 250)); writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const recordFilter = async (value: string) => {
    await until(() => js("!![...document.querySelectorAll('[aria-label=\"记录范围\"]')].find(e=>e.checkVisibility())"), '记录筛选缺失')
    await js("(()=>{const s=[...document.querySelectorAll('[aria-label=\"记录范围\"]')].find(e=>e.checkVisibility());Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s," + JSON.stringify(value) + ");s.dispatchEvent(new Event('change',{bubbles:true}))})()")
  }
  const finish = async (action: string) => {
    await click(action + '…')
    await until(() => js("!!document.querySelector('[aria-label=\"确认文件处置\"]')"), '未显示确认')
    await click('确认' + action)
    await until(() => js("[...document.querySelectorAll('.space-disposal [role=\"status\"]')].find(e=>e.checkVisibility())?.textContent.includes('1 项完成，0 项未完成')"), '处置未成功')
  }
  const openSpace = async (name: string) => {
    if (!await js("[...document.querySelectorAll('.file-spaces-tab')].some(e=>e.checkVisibility())")) await click('文件空间')
    await click(name, '.space-list-item strong')
  }
  const readJob = (root: string, fileId: string) => {
    const space = new FileSpace(root)
    try { return space.db.prepare('SELECT d.* FROM space_disposals d JOIN space_file_records r ON r.disposal_id=d.id WHERE r.file_id=?').get(fileId) as { bundle: string; manifest: string; stage: string } } finally { space.close() }
  }
  const recoverTestPackage = (root: string, bundle: string, destination = join(root, bundle)) => {
    assert.equal(process.platform, 'darwin', '此真实废纸篓检查仅适用于 macOS，Windows 另行实机验证')
    const trashed = join(homedir(), '.Trash', basename(bundle))
    assert(existsSync(trashed), '实际系统废纸篓中没有本次测试包')
    assert(existsSync(join(trashed, 'file-space-recovery.json')))
    renameSync(trashed, destination) // 模拟系统“放回原处”；不枚举或处理其他废纸篓项目。
  }
  if (process.env.CAPTURE_FLOW === 'spacedisposalresume') {
    const state = JSON.parse(readFileSync(join(dir, 'disposal-state.json'), 'utf8'))
    assert.equal((await callCore(a.core, 'fileStorageInfo', state.id)).lifecycle, 'disposed')
    assert.equal((await callCore(a.core, 'get', [state.id]))[0].blocks.note.data.text, '物理处置也保留的笔记')
    await openSpace('物理处置验收空间'); await click('记录管理'); await choose()
    await click('记录操作', '.space-disposal summary'); await finish('清理版本明细')
    await recordFilter('archived')
    await until(() => js("[...document.querySelectorAll('.space-file-list')].find(e=>e.checkVisibility())?.textContent.includes('版本明细已清理')"), '清理后的归档记录未显示')
    await choose()
    await shot('disposal-cleaned')
    const space = new FileSpace(state.root)
    try { assert.equal(space.db.prepare('SELECT count(*) FROM file_versions WHERE fileId=?').pluck().get(state.fileId), 0) } finally { space.close() }
    // 清理明细不会处理系统废纸篓里的包。测试完成后仅把自身包取回临时目录，避免留下垃圾。
    recoverTestPackage(state.root, state.bundle, join(dir, '已清理记录的测试文件包'))
    writeFileSync(join(dir, 'spacedisposalresume-result.json'), JSON.stringify({ ok: true, checks: ['重启状态与业务记录保留', 'UI 清理明细与归档', '保留文件身份', '系统废纸篓内容未被清空'] }))
    return
  }
  const info = await js('window.bridge.spaces.create(' + JSON.stringify(dir) + ',"物理处置验收空间","shared")')
  await callCore(a.core, 'linkFileSpace', info.root)
  const source = join(dir, '处置验收.png')
  await sharp({ create: { width: 180, height: 120, channels: 3, background: '#4f86a6' } }).png().toFile(source)
  const imported = await callCore(a.core, 'importToLibrary', [{ type: 'file', path: source }], { spaceId: info.id, requestId: randomUUID() })
  const id = imported.items[0].id
  await until(async () => !!(await callCore(a.core, 'get', [id]))[0].blocks.image, 'PNG 未经真实 utilityProcess 加工')
  await callCore(a.core, 'put', id, 'note', { text: '物理处置也保留的笔记' })
  const file = (await callCore(a.core, 'listSpaceFiles', { spaceId: info.id })).items[0]
  const b = await openLibrary(join(dir, '引用仓库B.library'), { show: false })
  try {
    await callCore(b.core, 'linkFileSpace', info.root)
    await callCore(b.core, 'adoptSpaceFiles', { spaceId: info.id, files: [{ id: file.id, revision: file.revision }], requestId: randomUUID() })
    const oldReference = String((await callCore(a.core, 'get', [id]))[0].blocks.file.data.path)
    const revision = new FileSpace(info.root)
    try { await js('window.bridge.spaces.setVersionPermission(' + JSON.stringify(info.root) + ',' + JSON.stringify(info.id) + ',' + JSON.stringify(a.id) + ',"revise",true,' + revision.info().revision + ')') } finally { revision.close() }
    await sharp({ create: { width: 180, height: 120, channels: 3, background: '#bf846d' } }).png().toFile(source)
    const p = await callCore(a.core, 'prepareFileEdit', { id, content: { type: 'file', path: source }, destination: { mode: 'publish' }, requestId: randomUUID() })
    await callCore(a.core, 'commitFileEdit', { editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() })
    await openSpace(info.name); await choose(); await click('移到系统废纸篓…')
    await until(() => js("document.querySelector('[aria-label=\"确认文件处置\"]')?.textContent.includes('共 2 个已发布版本')"), '未说明历史版本范围')
    win.setSize(1100, 800); await shot('disposal-confirm')
    win.setSize(900, 720)
    assert(await js('document.documentElement.scrollWidth<=window.innerWidth'), '窄窗口溢出')
    await shot('disposal-confirm-narrow')
    await click('取消', '[aria-label="确认文件处置"] button')
    assert.equal((await callCore(a.core, 'fileStorageInfo', id)).state, 'available')
    await finish('移到系统废纸篓')
    assert.equal((await callCore(a.core, 'fileStorageInfo', id)).lifecycle, 'disposed')
    assert.equal(await b.win.webContents.executeJavaScript('fetch(' + JSON.stringify('lib://' + b.id + '/' + oldReference) + ').then(r=>r.status)'), 403)
    const job = readJob(info.root, file.id)
    writeFileSync(join(dir, 'disposal-state.json'), JSON.stringify({ id, fileId: file.id, root: info.root, bundle: job.bundle }))
    assert(!existsSync(join(info.root, 'files/.versions', file.id)))
    await click('记录管理'); await choose(); await shot('disposal-record')
    recoverTestPackage(info.root, job.bundle)
    await finish('核验还原的文件')
    assert.equal((await callCore(a.core, 'fileStorageInfo', id)).state, 'available')
    assert.equal(await b.win.webContents.executeJavaScript('fetch(' + JSON.stringify('lib://' + b.id + '/' + oldReference) + ').then(r=>r.status)'), 200)
    await click('文件'); await choose(); await click('记录操作', '.space-disposal summary'); await finish('归档记录')
    await click('记录管理'); await recordFilter('archived'); await choose()
    await click('记录操作', '.space-disposal summary'); await finish('取消归档')
    await click('文件'); await choose(); await finish('移到系统废纸篓')
    const second = readJob(info.root, file.id)
    writeFileSync(join(dir, 'disposal-state.json'), JSON.stringify({ id, fileId: file.id, root: info.root, bundle: second.bundle }))
    writeFileSync(join(dir, 'spacedisposal-result.json'), JSON.stringify({ ok: true, checks: ['真实新 PNG 导入加工', '两库共享和两内容版本', 'UI 预览取消与系统废纸篓实际移动', '另一仓库旧版本停止读取', '取回测试包并 UI 校验恢复', '归档/取消归档', '宽窄窗口'] }))
  } finally { b.win.close(); await until(async () => b.win.isDestroyed(), 'B 未关闭'); await allClosed() }
}
