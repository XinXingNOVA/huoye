import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { click, script, until } from './theme-settings'

export async function spaceItemsFlow(win: BrowserWindow, dir: string) {
  const { space, note, ref } = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const lib = libraryOf(win.webContents)!
  const press = (name: string) => click(win, name)
  const visible = (s: string) => script(win, s)
  const onlyMissing = () => until(() => visible(`(() => {
    const input = [...document.querySelectorAll('dialog label')].find(l => l.textContent.includes('只看核对后缺失'))?.querySelector('input')
    if (!input) return false
    if (!input.checked) input.click()
    return true
  })()`), '缺失筛选未就绪')
  const collect = await callCore(lib.core, 'previewDirectoryCollection', space.id, ['md'])
  assert.equal((await callCore(lib.core, 'collectDirectoryFiles', space.id, ['md'], collect.token)).created, 1)
  await until(() => visible("[...document.querySelectorAll('button,.nav-item')].some(e => { if(e.checkVisibility() && (e.textContent.trim()==='文件空间' || e.getAttribute('aria-label')==='文件空间')){ e.click(); return true } return false })"), '文件空间未打开')
  await press(space.name)
  await press('查看本库素材'); await press('仅附件引用 1')
  await until(() => visible("document.querySelector('ul[aria-label=来源记录]')?.textContent.includes('项目复盘笔记')"), '独立笔记未出现')
  assert.equal(await visible("document.querySelectorAll('dialog input[type=checkbox]').length"), 0)
  await press('关闭')
  const original = join(space.root, '项目原文.md'), away = join(dir, '目录外的原文.md')
  renameSync(original, away)
  await press('核对整个空间')
  await until(() => visible("document.querySelector('[aria-label=原地目录]')?.textContent.includes('核对完成')"), '目录核对未完成')
  await press('查看本库素材'); await onlyMissing(); await press('选中全部主文件'); await press('预览回收（1）')
  await until(() => visible("!!document.querySelector('dialog [aria-label=来源处理预览]')"), '缺失回收预览未显示')
  renameSync(away, original)
  await press('确认移入本库回收站')
  await until(() => visible("document.querySelector('dialog [role=alert]')?.textContent.includes('重新核对')"), '文件找回后未拦住回收')
  assert.equal((await callCore(lib.core, 'query', {has:['file']})).ids.length, 1)
  await press('关闭')
  await visible("document.querySelector('.directory-management:not([open]) summary')?.click()")
  await press('解除目录关联'); await press('确认解除关联')
  await until(() => visible("!!document.querySelector('[aria-label=原地来源关联]')"), '解除关联后未能查看来源')
  await press('查看本库素材'); await press('选中全部主文件'); await press('预览回收（1）')
  await press('返回选择')
  assert.equal((await callCore(lib.core,'query',{has:['file']})).ids.length, 1)
  await press('预览回收（1）'); await press('确认移入本库回收站')
  await press('本库回收站 1')
  await until(() => visible("document.querySelector('ul[aria-label=来源记录]')?.textContent.includes('项目原文.md')"), '回收站未收到主文件')
  const [view] = await callCore(lib.core, 'get', [note])
  assert.equal(view.deletedAt, null)
  assert.deepEqual(view.blocks['sample-attachment'].data.files, [ref])
  await press('选中全部主文件'); await press('预览恢复（1）'); await press('确认从本库回收站恢复')
  await press('主文件 1')
  const [id] = (await callCore(lib.core, 'query', {has:['file']})).ids
  assert.ok(id)
  await press('关闭')
  assert.equal((await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path,ref)
  await visible('window.bridge.spaces.directories.maintenance.forget(' + JSON.stringify(space.id) + ')')
  await until(() => visible("document.querySelector('[aria-label=原地来源关联]')?.textContent.includes('缺少原目录登记簿')"), '未显示登记簿缺失')
  await press('查看本库素材'); await press('主文件 1'); await press('仅附件引用 1')
  await until(() => visible("document.querySelector('ul[aria-label=来源记录]')?.textContent.includes('项目复盘笔记')"), '失去登记簿后未能盘点附件')
  assert.equal(readFileSync(join(space.root, '项目原文.md'), 'utf8'), '独立原件')
  await press('关闭')
  const managedPath = join(dir, '另一空间的原文.md')
  writeFileSync(managedPath, '托管空间独立样本')
  const [managedId] = await callCore(lib.core, 'ingest', [{ type: 'file', path: managedPath }])
  const managed = (await callCore(lib.core, 'listFileSpaces')).find(s => s.default)!
  await press(managed.name); await press('查看本库素材'); await press('主文件 1')
  await until(() => visible("document.querySelector('ul[aria-label=来源记录]')?.textContent.includes('另一空间的原文.md')"), '托管来源未显示自己的素材')
  assert.equal((await callCore(lib.core, 'listSpaceItems', { spaceId: managed.id, group: 'primary', offset: 0 })).batchIds[0], managedId)
  await press('关闭')
  const info = await callCore(lib.core, 'fileStorageInfo', managedId)
  assert.ok(info.path)
  renameSync(info.path, join(dir, '移出的托管版本.md'))
  await press('查看本库素材'); await onlyMissing(); await press('打开磁盘检查'); await press('快速检查')
  await until(() => visible("document.querySelector('[aria-label=磁盘检查]')?.textContent.includes('检查完成')"), '托管空间核对未完成')
  await press('查看本库素材'); await onlyMissing(); await press('选中全部主文件'); await press('预览回收（1）'); await press('确认移入本库回收站')
  await press('本库回收站 1')
  assert.deepEqual((await callCore(lib.core, 'get', [note]))[0].blocks['sample-attachment'].data.files, [ref])
  assert.ok((await callCore(lib.core, 'get', [managedId]))[0].deletedAt)
  assert.equal(readFileSync(join(dir,'移出的托管版本.md'),'utf8'),'托管空间独立样本')
  writeFileSync(join(dir, 'spaceitems-result.json'), JSON.stringify({ ok: true, id, note, managedId }))
}
