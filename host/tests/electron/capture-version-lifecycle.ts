import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { fileUpdatesFlow } from './capture-file-updates'
import { openLibraries, openLibrary, allClosed } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { FileSpace } from '../../src/storage/file-space'
import { SpaceVersions } from '../../src/storage/space-versions'

/** 新文件导入及两库版本流程后，继续验证空间回收／恢复和历史发布的实际 UI。 */
export async function versionLifecycleFlow(win: BrowserWindow, dir: string) {
  await fileUpdatesFlow(win, dir)
  const a = openLibraries().find(l => l.win === win)!, second = join(dir, '协作仓库B.library')
  let b = await openLibrary(second, { show: false })
  const js = (window: BrowserWindow, code: string) => window.webContents.executeJavaScript(code)
  const until = async (fn: () => Promise<unknown>, label: string) => {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const click = async (window: BrowserWindow, label: string) => {
    await until(() => js(window, `(()=>{const el=[...document.querySelectorAll('button,.nav-item')].find(e=>e.checkVisibility()&&(e.getAttribute("aria-label")||e.textContent.trim())===${JSON.stringify(label)});if(!el||el.disabled)return false;el.click();return true})()`), `未找到可点击入口：${label}`)
  }
  const select = async () => {
    await until(() => js(win, `[...document.querySelectorAll('.space-file')].some(e=>e.textContent.includes('协作文档.md'))`), '文件未显示')
    await js(win, `(()=>{const input=[...document.querySelectorAll('.space-file')].find(e=>e.textContent.includes('协作文档.md')).querySelector('input');if(!input.checked)input.click()})()`)
  }
  const shot = async (name: string) => { await new Promise(r => setTimeout(r, 400)); writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG()) }
  try {
    const info = (await callCore(a.core, 'listFileSpaces')).find(s => s.name === '协作版本空间')!
    const af = (await callCore(a.core, 'listSpaceFiles', { spaceId: info.id })).items.find(f => f.name === '协作文档.md')!
    const bf = (await callCore(b.core, 'listSpaceFiles', { spaceId: info.id })).items.find(f => f.id === af.id)!
    const ai = af.collected!, bi = bf.collected!
    const settings = await callCore(b.core, 'getImportSettings')
    await callCore(b.core, 'setImportSettings', { defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId: info.id, automatic: false, updates: 'manual' }] })
    const oldPath = String((await callCore(b.core, 'get', [bi]))[0].blocks.file.data.path)
    await click(win, '空间设置')
    await until(() => js(win, `[...document.querySelectorAll('.space-permission')].some(e=>e.textContent.includes('回收和恢复原件'))`), '回收授权未显示')
    await js(win, `[...document.querySelectorAll('.space-permission')].find(e=>e.textContent.includes('验收仓库')&&e.textContent.includes('回收和恢复原件')).querySelector('input').click()`)
    await until(async () => (await callCore(a.core, 'listFileSpaces')).find(s => s.id === info.id)?.canRecycle, '回收授权未保存')
    await until(() => js(win, `![...document.querySelectorAll('.space-tabs button')].find(e=>e.getAttribute('aria-label')==='文件').disabled`), '授权处理未完成')
    await click(win, '文件'); await select(); await click(win, '回收原件…')
    await until(() => js(win, `!!document.querySelector('[aria-label="确认原件操作"]')`), '回收确认未显示')
    assert(await js(win, `document.querySelector('[aria-label="确认原件操作"]').textContent.includes('所有历史版本')`))
    await shot('version-recycle-confirm.png'); await click(win, '确认回收原件')
    await until(async () => (await callCore(a.core, 'fileStorageInfo', ai)).lifecycle === 'recycled', '空间未回收')
    for (const lib of [a, b]) assert.equal(await js(lib.win, `fetch(${JSON.stringify(`lib://${lib.id}/${oldPath}`)}).then(r=>r.status)`), 403)
    await callCore(b.core, 'trash', [bi])
    await until(() => js(win, `![...document.querySelectorAll('.space-tabs button')].find(e=>e.getAttribute('aria-label')==='空间回收站').disabled`), '回收未结束')
    await click(win, '空间回收站'); await select(); await click(win, '恢复原件…'); await click(win, '确认恢复原件')
    await until(async () => (await callCore(a.core, 'fileStorageInfo', ai)).lifecycle === 'active', '空间未恢复')
    assert.equal((await callCore(b.core, 'listSpaceFiles', { spaceId: info.id })).items.find(f => f.id === af.id)!.trashed, true)
    assert.match(await js(b.win, `fetch(${JSON.stringify(`lib://${b.id}/${oldPath}`)}).then(r=>r.text())`), /shared-version-three/)
    await until(() => js(win, `![...document.querySelectorAll('.space-tabs button')].find(e=>e.getAttribute('aria-label')==='文件').disabled`), '恢复未结束')
    await click(win, '文件'); await select(); await js(win, `[...document.querySelectorAll('.space-file')].find(e=>e.textContent.includes('协作文档.md')).parentElement.querySelector('.space-file-inspect').click()`); await click(win, '查看历史版本')
    await until(() => js(win, `document.querySelectorAll('.space-history-list li').length===3`), '历史版本未显示')
    await js(win, `[...document.querySelectorAll('.space-history-list li')].find(e=>e.querySelector('strong').textContent.startsWith('V1')).querySelector('button').click()`)
    await shot('version-history-confirm.png')
    win.setSize(960, 760); await new Promise(r => setTimeout(r, 200))
    assert(await js(win, `document.documentElement.scrollWidth<=window.innerWidth`), '窄窗口横向溢出')
    await js(win, `document.querySelector('[aria-label="确认恢复历史内容"]').scrollIntoView({block:'end'})`)
    await shot('version-history-narrow.png'); await click(win, '确认恢复为新版')
    await until(async () => (await callCore(a.core, 'fileStorageInfo', ai)).currentOrdinal === 4, '未发布恢复版 V4')
    assert.equal((await callCore(a.core, 'fileStorageInfo', ai)).contentOrdinal, 3)
    assert.equal((await callCore(b.core, 'fileStorageInfo', bi)).contentOrdinal, 3)
    await callCore(b.core, 'restore', [bi])
    const update = await callCore(b.core, 'previewFileUpdate', bi)
    assert.match(update.current.sample!, /shared-version-one/)
    await callCore(b.core, 'acceptFileUpdate', { id: bi, expectedPath: update.expectedPath, contentVersion: update.current.id, revision: update.revision, requestId: randomUUID() })
    await until(async () => String((await callCore(b.core, 'get', [bi]))[0].blocks.body?.data.content ?? '').includes('shared-version-one'), '恢复版未重新加工')
    assert.equal((await callCore(b.core, 'get', [bi]))[0].blocks.note.data.text, '仓库 B 的笔记')
    // 应用独立管理入口走 IPC，不借用仓库授权；重放保留回执。
    const image = (await callCore(a.core, 'listSpaceFiles', { spaceId: info.id })).items.find(f => f.name.endsWith('.png'))!
    const selection = { spaceId: info.id, action: 'recycle', files: [{ id: image.id, revision: image.revision }] }
    const preview = await js(win, `window.bridge.spaces.preview(${JSON.stringify(info.root)},${JSON.stringify(selection)})`)
    assert.equal(preview.references.scope, 'unchecked')
    const input = { ...selection, version: preview.version, requestId: randomUUID() }
    await js(win, `window.bridge.spaces.mutate(${JSON.stringify(info.root)},${JSON.stringify(input)})`)
    const restoreSelection = { ...selection, action: 'restore', files: [{ id: image.id, revision: image.revision + 1 }] }
    const restorePreview = await js(win, `window.bridge.spaces.preview(${JSON.stringify(info.root)},${JSON.stringify(restoreSelection)})`)
    await js(win, `window.bridge.spaces.mutate(${JSON.stringify(info.root)},${JSON.stringify({ ...restoreSelection, version: restorePreview.version, requestId: randomUUID() })})`)
    assert.equal((await js(win, `window.bridge.spaces.mutate(${JSON.stringify(info.root)},${JSON.stringify(input)})`)).replayed, true)
    b.win.close(); await until(async () => b.win.isDestroyed(), 'B 关闭失败'); await allClosed()
    b = await openLibrary(second, { show: false })
    assert.equal((await callCore(b.core, 'fileStorageInfo', bi)).contentOrdinal, 4)
    const versions = new SpaceVersions(new FileSpace(info.root))
    try { assert.equal(versions.versions(af.id).length, 4); assert.deepEqual(versions.changes().filter(c => c.type === 'recycled' || c.type === 'restored').map(c => c.type), ['recycled', 'restored', 'recycled', 'restored']) } finally { versions.space.close() }
    writeFileSync(join(dir, 'version-lifecycle-result.json'), JSON.stringify({ ok: true, spaceId: info.id, checks: ['B 批新文件及两库流程', 'UI 独立回收授权', 'UI 共享回收与恢复', '所有版本 lib:// 读取保护', '仓库回收状态保留', '历史列表及恢复为 V4', '各库保持旧版直到接纳', '重新加工与笔记保留', '应用独立 IPC 与回执重放', '关闭重开及窄窗口'] }, null, 2))
  } finally { if (!b.win.isDestroyed()) b.win.close(); await until(async () => b.win.isDestroyed(), 'B 关闭失败'); await allClosed() }
}
