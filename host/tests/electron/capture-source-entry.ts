import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { callCore } from '../../src/main/core-client'
import { openLibraries } from '../../src/main/libraries'
import { showLauncher } from '../../src/main/launcher'
import { prepareCreation, resumeCreation } from '../../src/main/library-creation'
import { click, script, until } from './theme-settings'

/** 只替换系统文件夹选择器和外部程序启动，仓库、收录、版本接纳均走生产入口。 */
export async function runSourceEntryCapture(launcher: BrowserWindow, dir: string) {
  const originalPicker = dialog.showOpenDialog, openPath = shell.openPath
  const home = realpathSync(dir), parent = join(home, '仓库位置'), source = join(home, '原地相册'), empty = join(home, '空文件夹')
  const image = join(source, '样本.png'), note = join(source, '说明.md'), extra = join(source, '第二份.md')
  let selected = '', lastOpened = '', picks = 0
  try {
    assert(process.env.RM_USER_DATA)
    for (const path of [source, parent, empty]) mkdirSync(path)
    const bytes = await sharp({ create: { width: 36, height: 64, channels: 3, background: '#53897a' } }).png().toBuffer()
    writeFileSync(image, bytes); writeFileSync(note, '初稿'); writeFileSync(extra, '另一份文档')
    dialog.showOpenDialog = (async () => { picks++; return { canceled: !selected, filePaths: selected ? [selected] : [] } }) as typeof originalPicker
    shell.openPath = async path => { lastOpened = path; return '' }
    await click(launcher, '从本地文件夹开始…')
    assert.equal(await script(launcher, '!!document.querySelector("#launcher-name")'), false)
    selected = empty; await click(launcher, '打开'); await click(launcher, '在这里新建仓库…')
    assert.equal(await script(launcher, 'document.querySelector("#launcher-name").value'), '空文件夹')
    assert(!existsSync(join(empty,'library.db')))
    await click(launcher, '← 返回')
    selected = source; await click(launcher, '从本地文件夹开始…')
    await until(() => script(launcher, '!!document.querySelector("#launcher-name")'), '没有进入建库页')
    assert.equal(await script(launcher, 'document.querySelector("#launcher-name").value'), '原地相册库')
    await click(launcher, '← 返回')
    await click(launcher, '打开')
    const count = picks
    await click(launcher, '用此文件夹新建仓库…')
    assert.equal(picks, count)
    selected = parent; await click(launcher, '选择位置…')
    // 用户编辑过库名时保留其选择。
    await script(launcher, `(() => { const el=document.querySelector('#launcher-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'样本仓库'); el.dispatchEvent(new Event('input',{bubbles:true})) })()`)
    await click(launcher, '视觉素材库'); await click(launcher, '创建并打开')
    const root = join(parent, '样本仓库')
    await until(() => openLibraries().some(l => l.root === root), '新库未打开')
    const lib = openLibraries().find(l => l.root === root)!, win = lib.win
    const ids = () => callCore(lib.core, 'query', { has: ['file'] }).then(r => r.ids)
    await click(win, '预览收录')
    await until(() => script(win, 'document.querySelector("dialog")?.textContent.includes("匹配 1 个")'), '未显示图片范围')
    assert.deepEqual(await ids(), [])
    await click(win, '收录 1 个文件')
    await until(() => script(win, 'document.querySelector("dialog")?.textContent.includes("已收录 1 个文件")'), '首次收录未提交')
    const [id] = await ids()
    await until(async () => !!(await callCore(lib.core, 'get', [id]))[0]?.blocks.thumb, '原地图片未生成缩略图')
    const ref = String((await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path)
    assert.equal(await script(win, 'window.bridge.files.resolve(' + JSON.stringify(ref) + ')'), image)
    assert.deepEqual(await script(win, 'window.bridge.files.identify(' + JSON.stringify([image,note]) + ')'), [id,null])
    assert.deepEqual(readFileSync(image), bytes)
    const managed = (await callCore(lib.core, 'listFileSpaces')).find(s => s.default)!
    assert.equal((await callCore(lib.core, 'listSpaceFiles', { spaceId: managed.id })).total, 0)
    await click(win, '浏览目录')
    await until(() => script(win, "!!document.querySelector('[aria-label=\"选择 说明.md\"]')"), '没有逐项收录入口')
    for (const name of ['说明.md','第二份.md']) await script(win, 'document.querySelector(' + JSON.stringify('input[aria-label="选择 ' + name + '"]') + ').click()')
    await click(win, '收录所选 2 项')
    await until(async () => (await ids()).length === 3, '选中的目录项没有收录')
    const [doc] = await script(win, 'window.bridge.files.identify(' + JSON.stringify([note]) + ')') as string[]
    await script(win, 'window.bridge.files.openOriginal(' + JSON.stringify(doc) + ')')
    assert.equal(lastOpened, note)
    writeFileSync(note, '二稿 · 外部编辑后接纳')
    assert((await callCore(lib.core,'fileStorageInfo',doc)).needsVerification)
    await assert.rejects(win.webContents.executeJavaScript('window.bridge.files.openOriginal(' + JSON.stringify(doc) + ')'))
    const row = `[...document.querySelectorAll('[aria-label=目录内容] li')].find(li=>li.textContent.includes('说明.md'))`
    await until(() => script(win, `(()=>{const b=[...${row}?.querySelectorAll('button')??[]].find(b=>b.textContent==='在库中查看'); if(!b)return false;b.click();return true})()`), '找不到本库记录')
    // 数据详情与右侧检查器使用同一文件存储组件。
    await click(win, '核对并预览新版…'); await click(win, '接纳新版')
    await until(async () => (await callCore(lib.core,'fileStorageInfo',doc)).state === 'available', '本库尚未接纳')
    assert.deepEqual(await script(win, 'window.bridge.files.identify(' + JSON.stringify([note]) + ')'), [doc])
    assert.equal(await script(win, 'window.bridge.creation.introduction()'), null)
    const another = join(home, '第二个素材来源'); mkdirSync(another); selected = another
    await click(win, '导入文件'); await click(win, '关联本地文件夹（不复制）…')
    await until(() => script(win, "[...document.querySelectorAll('.directory-panel')].some(p=>p.checkVisibility() && p.querySelector('h2')?.textContent==='第二个素材来源' && p.querySelector('section[aria-label=按文件类型收录]'))"), '日常导入没有定位到所选目录的收录预览')
    const copied = await callCore(lib.core, 'makeFileIndependent', doc, managed.id, 'source-entry-managed-copy')
    assert.equal(copied.library.state, 'accepted')
    assert.equal((await callCore(lib.core, 'fileStorageInfo',doc)).storageKind, 'space')
    assert.equal(readFileSync(note,'utf8'),'二稿 · 外部编辑后接纳')
    assert.equal((await ids()).length, 3)
    await click(win, '全部视图')
    const card = JSON.stringify('[data-entity-id="' + id + '"]')
    const newer = await sharp({create:{width:72,height:64,channels:3,background:'#896547'}}).png().toBuffer()
    writeFileSync(image, newer)
    await until(() => script(win, `(() => { const el=[...document.querySelectorAll(${card})].find(c=>c.checkVisibility()); if(!el)return false; el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true })()`), '没有已收录的图片卡片')
    await click(win, '接纳到本仓库')
    await until(async () => (await callCore(lib.core,'fileStorageInfo',id)).state==='available', '从画布打开未接纳图片新版')
    assert.deepEqual(await script(win, 'window.bridge.files.identify(' + JSON.stringify([image]) + ')'), [id])
    assert.deepEqual(readdirSync(source).sort(), ['样本.png','说明.md','第二份.md'].sort())
    launcher = showLauncher(false)
    selected = root; await click(launcher, '从本地文件夹开始…'); await click(launcher, '打开此仓库')
    assert.equal(openLibraries().filter(l => l.root === root).length, 1)
    // 建库途中来源被移走，可接续同一个 job 与仓库身份。
    const recoverySource = join(home, '待接续的目录')
    mkdirSync(recoverySource)
    const st = statSync(recoverySource, { bigint:true }), job = prepareCreation({ parent, name:'接续库' }, undefined, { root: recoverySource, device:String(st.dev), inode:String(st.ino) })
    renameSync(recoverySource, recoverySource+'.away')
    const failed = await resumeCreation(job.id,{show:false})
    assert('error' in failed && failed.recovery?.id === job.id)
    renameSync(recoverySource+'.away',recoverySource)
    assert('ok' in await resumeCreation(job.id,{show:false}))
    const recovered = openLibraries().find(l => l.id === job.libraryId)!
    assert.equal((await recovered.win.webContents.executeJavaScript('window.bridge.spaces.directories.list()'))[0].root,recoverySource)
    writeFileSync(join(dir,'sourceentry-result.json'), JSON.stringify({ ok: true, collected: 3, reopened: true, resumed: true }))
  } catch (e) {
    console.error('[sourceentry]', e, (e as Error).cause)
    for(const win of [launcher,...openLibraries().map(l=>l.win)]) if (!win.isDestroyed()) {
      console.error('[sourceentry UI]', await win.webContents.executeJavaScript('document.body.innerText').catch(()=>'')); break
    }
    process.exitCode = 1
  } finally { dialog.showOpenDialog = originalPicker; shell.openPath = openPath; app.quit() }
}
