import assert from 'node:assert/strict'
import { findSettingsSurface, settingsScript, settingsSurface } from './settings-surface'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shell, dialog, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { editorLauncher } from '../../src/main/local-editors'
import type { FileEditingTask } from '../../src/shared/file-editing'

export async function fileEditingFlow(win: BrowserWindow, dir: string, chooseMenu: (label: string) => void) {
  const lib = libraryOf(win.webContents)!, js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const until = async (check: () => Promise<unknown>, label: string) => {
    for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error('未完成：' + label)
  }
  const click = (label: string) => until(() => js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label)
  const clickIn = (selector: string, label: string) => until(() => js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector+' button')})].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), label)
  const list = (): Promise<FileEditingTask[]> => js('window.bridge.fileEditing.list()')
  const task = async (id: string) => (await list()).find(t => t.itemId === id && !t.ended)
  const all = async () => {
    await js(`[...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title')?.textContent==='全部').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  }
  const card = (id: string) => `.tab-pane:not(.hidden) [data-entity-id="${id}"]`
  const select = (id: string) => until(() => js(`(()=>{const e=document.querySelector(${JSON.stringify(card(id))});if(!e)return false;e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return true})()`), '选中素材')
  const edit = async (id: string) => {
    await all(); chooseMenu('编辑文件')
    await until(() => js(`(()=>{const e=document.querySelector(${JSON.stringify(card(id))});if(!e)return false;e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return true})()`), '素材右键直接编辑')
    await until(async () => !!await task(id), '工作副本创建')
  }
  const editingView = async () => {
    await until(() => js("(()=>{const b=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.startsWith('编辑中'));if(!b)return false;b.click();return true})()"), '编辑中视图')
    await until(() => js("!!document.querySelector('.tab-pane:not(.hidden) .editing-view-bar')"), '集合视图就绪')
  }
  const editorFixture = (name: string) => {
    const path = join(dir, name + (process.platform === 'darwin' ? '.app' : '.exe'))
    if (process.platform === 'darwin') { mkdirSync(join(path, 'Contents'), { recursive: true }); writeFileSync(join(path, 'Contents', 'Info.plist'), '') }
    else writeFileSync(path, '', { mode: 0o700 })
    return path
  }
  const open = shell.openPath, picker = dialog.showOpenDialog
  const paths: string[] = [], selectedEditors: string[] = []; let fail = false
  const selectedOpen = editorLauncher.open
  editorLauncher.open = async (editor, path) => { selectedEditors.push(editor.id); paths.push(path); return fail ? '测试：编辑器启动失败' : '' }
  shell.openPath = async path => { paths.push(path); return fail ? '测试：没有系统关联' : '' }
  try {
    if (['fileeditingdisabled', 'fileeditinguninstalled'].includes(process.env.CAPTURE_FLOW ?? '')) {
      const saved = JSON.parse(readFileSync(join(dir, 'editing-saved.json'), 'utf8'))
      const pending = await task(saved.textId)
      assert.equal(pending?.id, saved.taskId); assert.equal(pending?.phase, 'ready')
      assert.equal(readFileSync(saved.work, 'utf8'), '# 重启后继续')
      assert.equal((await callCore(lib.core, 'fileStorageInfo', saved.textId)).contentVersion, saved.beforeRestart)
      assert(!await js("[...document.querySelectorAll('.nav-item')].some(e=>e.textContent.startsWith('编辑中'))"))
      await all(); await select(saved.textId); chooseMenu('编辑文件')
      await js(`document.querySelector(${JSON.stringify(card(saved.textId))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
      await until(() => js("document.querySelector('.toast')?.textContent.includes('请先安装并启用文件编辑插件')"), '缺少界面时解释且不修改任务')
      assert.equal(paths.length, 0); assert.deepEqual(await task(saved.textId), pending)
      assert(!await js("document.querySelector('.file-editing-dialog') || document.querySelector('.editing-view-bar') || document.querySelector('.card .badge')"))
      writeFileSync(join(dir, process.env.CAPTURE_FLOW + '-result.json'), JSON.stringify({ok:true})); return
    }
    if (process.env.CAPTURE_FLOW === 'fileeditingresume') {
      const saved = JSON.parse(readFileSync(join(dir, 'editing-saved.json'), 'utf8'))
      assert.equal((await callCore(lib.core, 'fileStorageInfo', saved.textId)).contentVersion, saved.beforeRestart)
      assert.equal((await task(saved.textId))?.phase, 'ready')
      await editingView(); await select(saved.textId)
      await clickIn('.editing-view-bar', '继续编辑')
      await until(async () => paths.length > 0, '复用工作副本')
      assert.equal(paths.at(-1), saved.work)
      await clickIn('.editing-view-bar', '完成编辑')
      await until(async () => !(await task(saved.textId)), '重启后完成保存和清理')
      assert(!existsSync(saved.work))
      await until(async () => String((await callCore(lib.core, 'get', [saved.textId]))[0].blocks.body?.data.content).includes('重启后继续'), '接纳并加工')
      // 无活动任务时动态范围为空，不能退回“全部”。
      await until(() => js("document.querySelector('.tab-pane:not(.hidden) .toolbar-count')?.textContent.trim()==='0 项'"), '空编辑视图')
      await all(); await edit(saved.textId); await until(async () => paths.length > 1, '新副本')
      const version = (await callCore(lib.core, 'fileStorageInfo', saved.textId)).contentVersion
      await editingView(); await select(saved.textId); await clickIn('.editing-view-bar', '完成编辑')
      await until(async () => !(await task(saved.textId)), '无变化直接清理')
      assert.equal((await callCore(lib.core, 'fileStorageInfo', saved.textId)).contentVersion, version)
      // 本机登记与本库格式偏好跨进程保留，未将无扩展名文件归为一类。
      const custom = await js(`window.bridge.fileEditing.start({id:${JSON.stringify(saved.unknownId)}})`)
      const options = await js(`window.bridge.fileEditing.editorOptions(${JSON.stringify(custom.id)})`)
      assert.equal(options.preferred, saved.editorId)
      await js(`window.bridge.fileEditing.open(${JSON.stringify(custom.id)})`)
      assert.equal(selectedEditors.at(-1), saved.editorId)
      await js(`window.bridge.fileEditing.finish({taskId:${JSON.stringify(custom.id)}})`)
      win.webContents.send('menu:command', 'settings')
      await until(async () => !!findSettingsSurface(win), '设置窗口')
      const settings = (code: string) => settingsScript(win, code)
      const settingButton = (scope: string, title: string) => until(() => settings(`(() => {
        const button = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(title)})
        if (!button || button.disabled) return false
        button.click()
        return true
      })()`), title)
      await settingButton('.application-settings-nav', '文件空间与外部应用')
      await settingButton('.settings-subnav', '外部编辑器')
      await until(() => settings("document.querySelector('.local-editor-settings')?.textContent.includes('测试编辑器')"), '应用编辑器设置')
      writeFileSync(join(dir, 'editor-settings.png'), (await settingsSurface(win).webContents.capturePage()).toPNG())
      await settingButton('.local-editor-settings', '移除')
      await until(() => settings("document.querySelectorAll('.local-editor-settings li').length===1"), '移除编辑器登记')
      const again = await js(`window.bridge.fileEditing.start({id:${JSON.stringify(saved.unknownId)}})`)
      assert.equal((await js(`window.bridge.fileEditing.editorOptions(${JSON.stringify(again.id)})`)).preferred, undefined)
      await js(`window.bridge.fileEditing.finish({taskId:${JSON.stringify(again.id)}})`)
      writeFileSync(join(dir, 'fileeditingresume-result.json'), JSON.stringify({ ok: true })); return
    }
    const text = join(dir, '编辑流程.md'), image = join(dir, '编辑图片.png')
    writeFileSync(text, '# 初始内容')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#587ca4' } }).png().toFile(image)
    const imported = await callCore(lib.core, 'importToLibrary', [{ type: 'file', path: text }, { type: 'file', path: image }], { requestId: randomUUID() })
    assert.equal(imported.errors.length, 0)
    const [textId, imageId] = imported.items.map(v => v.id)
    await until(async () => (await callCore(lib.core, 'get', [textId, imageId])).every(v => v.blocks.body || v.blocks.image), '新文件原生加工')
    fail = true; await edit(textId)
    await until(() => js("document.querySelector('.file-editing-dialog')?.textContent.includes('没有系统关联')"), '启动失败保留副本')
    fail = false; await clickIn('.file-editing-dialog', '继续编辑')
    await until(async () => paths.length === 2, '重试启动')
    const work = paths.at(-1)!, original = await callCore(lib.core, 'fileStorageInfo', textId)
    writeFileSync(work, '# 第一次修改')
    assert.equal(readFileSync(original.path!, 'utf8'), '# 初始内容')
    await editingView(); await select(textId)
    await until(() => js(`document.querySelector(${JSON.stringify(card(textId)+' .badge')})?.textContent.includes('编辑中')`), '素材状态角标')
    await until(() => js(`document.querySelector('[data-inspector-section="section:file-editing.controls"] .file-editing-controls')?.checkVisibility()`), '插件详情分区显示活动任务')
    await js("document.querySelector('.editing-view-bar button[aria-label=编辑选项]').click()")
    await js("document.querySelector('.file-editing-dialog details').open=true")
    await clickIn('.file-editing-dialog', '预览修改')
    await until(async () => (await task(textId))?.phase === 'ready', '准备文本预览')
    writeFileSync(work, '# 检查后继续修改')
    await clickIn('.file-editing-dialog', '完成编辑')
    await until(() => js("document.querySelector('.file-editing-error')?.textContent.includes('EDIT_CHANGED')"), '拒绝过期预览')
    await click('重新检查／更换保存方式')
    await until(async () => (await task(textId))?.phase === 'editing', '重查允许新准备')
    await clickIn('.file-editing-dialog', '完成编辑')
    await until(async () => !(await task(textId)), '组合保存清理')
    assert(!existsSync(work)); assert.equal((await callCore(lib.core, 'fileStorageInfo', textId)).contentOrdinal, 2)
    await until(async () => String((await callCore(lib.core, 'get', [textId]))[0].blocks.body?.data.content).includes('检查后继续修改'), '文字重新加工')

    await edit(imageId); await until(async () => paths.at(-1)?.endsWith('.png'), '图片工作副本')
    const imageWork = paths.at(-1)!
    writeFileSync(imageWork, await sharp({ create: { width: 240, height: 160, channels: 3, background: '#bd8b49' } }).png().toBuffer())
    await editingView(); await select(imageId)
    await js("document.querySelector('.editing-view-bar button[aria-label=编辑选项]').click(); document.querySelector('.file-editing-dialog details')?.setAttribute('open','')")
    await until(() => js("!!document.querySelector('.file-editing-dialog details')"), '图片编辑选项')
    await js("document.querySelector('.file-editing-dialog details').open=true")
    await click('预览修改')
    await until(() => js("document.querySelectorAll('.file-editing-images img').length===2&&[...document.querySelectorAll('.file-editing-images img')].every(e=>e.naturalWidth>0)"), '受控图片预览')
    writeFileSync(join(dir, 'editing-preview.png'), (await win.webContents.capturePage()).toPNG())
    await clickIn('.file-editing-dialog', '完成编辑')
    await until(async () => !(await task(imageId)), '图片完成清理')
    await until(async () => (await callCore(lib.core, 'get', [imageId]))[0].blocks.image?.data.width === 240, '图片重新加工')
    assert(!existsSync(imageWork))

    // 缺失副本与已回收素材仍有处理入口，放弃不删除仓库素材或原件。
    await edit(imageId); await until(async () => paths.at(-1) !== imageWork, '再次创建图片副本')
    const missingWork = paths.at(-1)!; unlinkSync(missingWork)
    await callCore(lib.core, 'trash', [imageId]); await editingView()
    await until(() => js("document.querySelector('.editing-recovery')?.textContent.includes('编辑图片.png')"), '回收后保留恢复入口')
    await js("document.querySelector('.editing-recovery button').click()")
    await click('放弃修改…'); await click('确认放弃并清理')
    await until(async () => !(await task(imageId)), '缺失副本可明确放弃')
    await callCore(lib.core, 'restore', [imageId])
    assert.equal((await callCore(lib.core, 'fileStorageInfo', imageId)).state, 'available')

    // 有冲突时保留并提供独立副本选择。
    await edit(textId); await until(async () => paths.at(-1)?.endsWith('.md') && paths.at(-1) !== work, '新的文字副本')
    let textWork = paths.at(-1)!; writeFileSync(textWork, '# 自己的工作内容')
    const current = await callCore(lib.core, 'prepareFileEdit', { id: textId, destination: { mode: 'publish' }, content: { type: 'text', text: '# 另一入口更新' }, requestId: randomUUID() })
    await callCore(lib.core, 'commitFileEdit', { editId: current.editId, previewToken: current.previewToken, requestId: randomUUID() })
    await editingView(); await select(textId); await clickIn('.editing-view-bar', '完成编辑')
    await until(() => js("document.querySelector('.file-editing-error')?.textContent.includes('EDIT_CONFLICT')"), '基线冲突保留')
    const privateSpace = (await callCore(lib.core, 'listFileSpaces')).find(s => s.mode === 'private')!
    await js(`(()=>{const e=document.querySelector('.file-editing-dialog select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(privateSpace.id)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await clickIn('.file-editing-dialog', '完成编辑')
    await until(async () => !(await task(textId)), '保存独立副本后清理')
    assert.notEqual((await callCore(lib.core, 'fileStorageInfo', textId)).fileId, original.fileId)
    assert(!existsSync(textWork))

    // 原生进程导入未知和无扩展名文件；应用选择器与程序启动用隔离替身。
    const unknown = join(dir, '模型.blend'), extensionless = join(dir, 'README')
    writeFileSync(unknown, 'unknown-before'); writeFileSync(extensionless, 'extensionless-before')
    const extra = await callCore(lib.core, 'importToLibrary', [{ type: 'file', path: unknown }, { type: 'file', path: extensionless }], { requestId: randomUUID() })
    assert.equal(extra.errors.length, 0)
    const [unknownId, extensionlessId] = extra.items.map(v => v.id)
    const app = editorFixture('测试编辑器')
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [app] })) as typeof dialog.showOpenDialog
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
    assert.equal(await js(`window.bridge.fileEditing.chooseReplacement(${JSON.stringify(unknownId)})`), null)
    assert.equal(await task(unknownId), undefined)
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [app] })) as typeof dialog.showOpenDialog
    await edit(unknownId); await until(() => js("!!document.querySelector('.editor-chooser')"), '未知格式选择编辑器')
    await clickIn('.editor-chooser', '选择其他应用…')
    await until(() => js("[...document.querySelectorAll('.editor-chooser option')].some(e=>e.textContent==='测试编辑器')"), '编辑器登记')
    await js("document.querySelector('.editor-chooser input[type=checkbox]').click()")
    fail = true; await clickIn('.editor-chooser', '打开工作副本')
    await until(() => js("document.querySelector('.editor-chooser')?.textContent.includes('编辑器启动失败')"), '启动失败保留并反馈')
    fail = false; await clickIn('.editor-chooser', '打开工作副本')
    await until(() => js("!document.querySelector('.editor-chooser')"), '打开所选编辑器')
    const customTask = (await task(unknownId))!, customWork = paths.at(-1)!, editorId = selectedEditors.at(-1)!
    writeFileSync(customWork, 'unknown-after')
    const beforeReuse = paths.length
    await edit(unknownId); await until(async () => paths.length > beforeReuse && paths.at(-1) === customWork, '偏好复用副本')
    assert.equal((await task(unknownId))!.id, customTask.id)
    await editingView(); await select(unknownId); await js("document.querySelector('.editing-view-bar button[aria-label=编辑选项]').click()")
    await clickIn('.file-editing-dialog', '选择编辑器…')
    const secondApp = editorFixture('第二编辑器')
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [secondApp] })) as typeof dialog.showOpenDialog
    await clickIn('.editor-chooser', '选择其他应用…')
    await until(() => js("document.querySelector('.editor-chooser select')?.selectedOptions[0]?.textContent==='第二编辑器'"), '选择另一编辑器')
    writeFileSync(join(dir, 'editor-chooser.png'), (await win.webContents.capturePage()).toPNG())
    await clickIn('.editor-chooser', '打开工作副本')
    await until(() => js("!document.querySelector('.editor-chooser')"), '切换编辑器')
    assert.notEqual(selectedEditors.at(-1), editorId); assert.equal(paths.at(-1), customWork)
    await clickIn('.editing-view-bar', '完成编辑'); await until(async () => !(await task(unknownId)), '未知格式保存')
    assert.equal(readFileSync((await callCore(lib.core, 'fileStorageInfo', unknownId)).path!, 'utf8'), 'unknown-after')
    await edit(extensionlessId); await until(() => js("!!document.querySelector('.editor-chooser')"), '无扩展名选择编辑器')
    assert.equal(await js("document.querySelector('.editor-chooser input[type=checkbox]') === null"), true)
    await clickIn('.editor-chooser', '打开工作副本'); await until(() => js("!document.querySelector('.editor-chooser')"), '无扩展名打开')
    const noExtWork = paths.at(-1)!; assert(noExtWork.endsWith('编辑-README')); writeFileSync(noExtWork, 'extensionless-after')
    await editingView(); await select(extensionlessId); await clickIn('.editing-view-bar', '完成编辑')
    await until(async () => !(await task(extensionlessId)), '无扩展名保存清理')
    assert.equal(readFileSync((await callCore(lib.core, 'fileStorageInfo', extensionlessId)).path!, 'utf8'), 'extensionless-after')
    assert(!existsSync(noExtWork)); dialog.showOpenDialog = picker

    // 替换入口和旧版未确认准备也继续沿相同协议，不自动发布。
    const replacement = join(dir, '替换文字.md'); writeFileSync(replacement, '# 重启后继续')
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [replacement] })) as typeof dialog.showOpenDialog
    await all(); await select(textId); chooseMenu('文件存储…')
    await js(`document.querySelector(${JSON.stringify(card(textId))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
    await click('选择替换文件…'); await until(async () => !!await task(textId), '替换副本')
    dialog.showOpenDialog = picker
    await until(() => js("!!document.querySelector('.file-editing-dialog details')"), '替换修改选项')
    await js("document.querySelector('.file-editing-dialog details').open=true")
    await click('预览修改'); await until(async () => (await task(textId))?.phase === 'ready', '留待重启确认')
    const pending = await task(textId)
    // 打开一次现有工作副本以记录路径，不触发发布。
    await clickIn('.file-editing-dialog', '继续编辑'); await until(async () => paths.at(-1)?.endsWith('.md') && paths.at(-1) !== textWork, '替换副本路径')
    textWork = paths.at(-1)!
    assert.equal((await task(textId))?.id, pending!.id)
    const beforeRestart = (await callCore(lib.core, 'fileStorageInfo', textId)).contentVersion
    await editingView(); await select(textId)
    win.setSize(960, 760); await new Promise(r => setTimeout(r, 300))
    assert(await js('document.documentElement.scrollWidth <= innerWidth'), '窄窗口横向溢出')
    writeFileSync(join(dir, 'editing-narrow.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(join(dir, 'editing-saved.json'), JSON.stringify({ textId, imageId, unknownId, editorId, work: textWork, beforeRestart, taskId: pending!.id }))
    writeFileSync(join(dir, 'fileediting-result.json'), JSON.stringify({ ok: true, systemApplication: 'stubbed', imports: 4, checks: ['直接编辑', '状态视图', '工作副本隔离', '过期预览拒绝', '完成保存与清理', 'PNG 预览与加工', '缺失副本和回收恢复入口', '替换文件', '冲突与独立副本', '窄窗口', '编辑器登记与切换', '按库格式偏好', '未知格式及无扩展名'] }))
  } catch (e) {
    writeFileSync(join(dir, 'editing-error.txt'), String(e) + '\n' + await js('document.body.innerText'))
    writeFileSync(join(dir, 'editing-error.png'), (await win.webContents.capturePage()).toPNG()); throw e
  } finally { shell.openPath = open; dialog.showOpenDialog = picker; editorLauncher.open = selectedOpen }
}
