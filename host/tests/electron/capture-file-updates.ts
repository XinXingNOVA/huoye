import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { dialog, type BrowserWindow } from 'electron'
import { openLibraries, openLibrary, allClosed } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { FileSpace } from '../../src/storage/file-space'
import { SpaceVersions } from '../../src/storage/space-versions'

export async function fileUpdatesFlow(win: BrowserWindow, dir: string) {
  const a = openLibraries().find(l => l.win === win)!
  const js = (window: BrowserWindow, code: string) => window.webContents.executeJavaScript(code)
  const until = async (check: () => Promise<unknown>, label: string) => {
    for (let i=0;i<200;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,100)) }
    throw new Error(label)
  }
  const click = async (window: BrowserWindow, label: string) => {
    assert(await js(window, `(()=>{const el=[...document.querySelectorAll('button,.nav-item')].find(e=>(e.getAttribute("aria-label")||e.textContent.trim())===${JSON.stringify(label)});if(!el || el.disabled)return false;el.click();return true})()`), `未找到可点击入口：${label}`)
  }
  const source=join(dir,'协作文档.md'),png=join(dir,'协作图像.png')
  writeFileSync(source,'# 原始内容\n\nshared-version-one')
  await sharp({create:{width:320,height:200,channels:3,background:'#428cbb'}}).png().toFile(png)
  const info=await js(win,`window.bridge.spaces.create(${JSON.stringify(dir)},'协作版本空间','shared')`)
  assert.equal(info.versioned,true)
  await callCore(a.core,'linkFileSpace',info.root)
  const imported=await callCore(a.core,'importToLibrary',[{type:'file',path:source},{type:'file',path:png}],{spaceId:info.id,requestId:randomUUID()})
  assert.equal(imported.errors.length,0);const ai=imported.items[0].id, imageId=imported.items[1].id
  await until(async()=>{const rows=await callCore(a.core,'get',[ai,imageId]);return rows[0]?.blocks.body && rows[1]?.blocks.image},'新 PNG/Markdown 未在真实 utilityProcess 完成加工')
  const second=join(dir,'协作仓库B.library');mkdirSync(second)
  let b=await openLibrary(second,{show:false})
  try {
    await callCore(b.core,'linkFileSpace',info.root)
    const page=await callCore(a.core,'listSpaceFiles',{spaceId:info.id})
    const adopted=await callCore(b.core,'adoptSpaceFiles',{spaceId:info.id,requestId:randomUUID(),files:page.items.map(f=>({id:f.id,revision:f.revision}))})
    const bid=(adopted.result as {items:{id:string}[]}).items.map(i=>i.id)
    await until(async()=> (await callCore(b.core,'get',bid)).every(i=>i.blocks.body||i.blocks.image),'B 加工未完成')
    const bi=(await callCore(b.core,'get',bid)).find(i=>i.blocks.file.data.ext==='md')!.id
    await callCore(a.core,'put',ai,'note',{text:'仓库 A 的笔记'});await callCore(b.core,'put',bi,'note',{text:'仓库 B 的笔记'})
    const read=async(window:BrowserWindow,libraryId:string,path:string)=>js(window,`fetch(${JSON.stringify(`lib://${libraryId}/${path}`)}).then(r=>{if(!r.ok)throw Error(r.status);return r.text()})`)
    const old=String((await callCore(b.core,'get',[bi]))[0].blocks.file.data.path)
    assert.match(await read(b.win,b.id,old),/shared-version-one/)
    // A：实际点击选择替换、确认发布；仅原生文件选择框用预定测试文件返回。
    await click(win,'文件空间');await until(()=>js(win,`!!document.querySelector('.space-tabs')`),'A 空间页未显示')
    await click(win,'协作版本空间');await until(()=>js(win,`[...document.querySelectorAll('.space-file')].some(e=>e.textContent.includes('协作文档.md'))`),'空间文件未显示')
    await click(win,'空间设置')
    await until(()=>js(win,`!!document.querySelector('.space-permission input')`),'更新授权列表未显示')
    await js(win,`[...document.querySelectorAll('.space-permission')].find(e=>e.textContent.includes('验收仓库')).querySelector('input').click()`)
    await until(async()=> (await callCore(a.core,'listFileSpaces')).find(s=>s.id===info.id)?.canRevise,'空间更新授权未保存')
    await until(()=>js(win,`![...document.querySelectorAll('.space-tabs button')].find(e=>e.getAttribute('aria-label')==='文件').disabled`),'授权操作未完成')
    await click(win,'文件')
    await js(win,`[...document.querySelectorAll('.space-file')].find(e=>e.textContent.includes('协作文档.md')).parentElement.querySelector('.space-file-inspect').click()`)
    await until(()=>js(win,`!!document.querySelector('.space-version-actions')`),'单文件详情未显示')
    await click(win,'修改文件…')
    writeFileSync(source,'# 新版内容\n\nshared-version-two')
    const originalDialog=dialog.showOpenDialog
    dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[source]})) as typeof dialog.showOpenDialog
    try { await click(win,'修改共享原件：选择替换文件…');await until(()=>js(win,`!!document.querySelector('[aria-label="确认发布共享新版"]')`),'替换草稿未就绪') }
    catch (error) { writeFileSync(join(dir,'file-update-ui-error.txt'),await js(win,'document.body.innerText')); writeFileSync(join(dir,'file-update-ui-error.png'),(await win.webContents.capturePage()).toPNG()); throw error }
    finally {dialog.showOpenDialog=originalDialog}
    await new Promise(r=>setTimeout(r,400))
    writeFileSync(join(dir,'shared-publish-confirm.png'),(await win.webContents.capturePage()).toPNG())
    await click(win,'确认发布并接纳')
    await until(async()=>String((await callCore(a.core,'get',[ai]))[0].blocks.body?.data.content??'').includes('shared-version-two'),'A 新版加工未完成')
    assert.match(await read(b.win,b.id,old),/shared-version-one/)
    assert.equal((await callCore(b.core,'fileStorageInfo',bi)).currentOrdinal,2)
    // B：UI 对比旧版、新版，明确接纳。
    await until(()=>js(b.win,`!![...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()==='文件空间')`),'B 窗口未就绪')
    await click(b.win,'文件空间');await until(()=>js(b.win,`!!document.querySelector('.space-tabs')`),'B 空间页未显示')
    await click(b.win,'协作版本空间');await until(()=>js(b.win,`[...document.querySelectorAll('.space-file')].some(e=>e.textContent.includes('协作文档.md'))`),'B 候选未显示')
    await js(b.win,`[...document.querySelectorAll('.space-file')].find(e=>e.textContent.includes('协作文档.md')).parentElement.querySelector('.space-file-inspect').click()`)
    await until(()=>js(b.win,`!!document.querySelector('.space-version-actions')`),'B 单文件详情未显示')
    await js(b.win,`document.querySelector('.space-version-actions button').click()`);await until(()=>js(b.win,`!!document.querySelector('[aria-label="预览内容更新"]')`),'更新比较未显示')
    await new Promise(r=>setTimeout(r,400))
    writeFileSync(join(dir,'shared-update-preview.png'),(await b.win.webContents.capturePage()).toPNG())
    b.win.setSize(960,760);await new Promise(r=>setTimeout(r,200))
    assert(await js(b.win,`document.documentElement.scrollWidth<=window.innerWidth`),'窄窗口横向溢出')
    writeFileSync(join(dir,'shared-update-narrow.png'),(await b.win.webContents.capturePage()).toPNG())
    await click(b.win,'接纳到本仓库')
    await until(async()=>String((await callCore(b.core,'get',[bi]))[0].blocks.body?.data.content??'').includes('shared-version-two'),'B 新版未加工')
    assert.equal((await callCore(b.core,'get',[bi]))[0].blocks.note.data.text,'仓库 B 的笔记')
    // 关闭 B，A 发布 V3，重新打开通过持久序列追赶（无需常驻同步）。
    const settings=await callCore(b.core,'getImportSettings')
    await callCore(b.core,'setImportSettings',{defaultSpaceId:settings.defaultSpaceId,collect:true,spaces:[{spaceId:info.id,automatic:false,updates:'automatic'}]})
    b.win.close();await until(async()=>b.win.isDestroyed(),'B 窗口未关闭');await allClosed()
    writeFileSync(source,'# 第三版\n\nshared-version-three')
    const draft=await callCore(a.core,'prepareFileEdit',{id:ai,content:{type:'file',path:source},destination:{mode:'publish'},requestId:randomUUID()})
    await callCore(a.core,'commitFileEdit',{editId:draft.editId,previewToken:draft.previewToken,requestId:randomUUID()})
    b=await openLibrary(second,{show:false})
    await until(async()=>String((await callCore(b.core,'get',[bi]))[0].blocks.body?.data.content??'').includes('shared-version-three'),'B 重开追赶失败')
    assert.equal((await callCore(b.core,'get',[bi]))[0].blocks.note.data.text,'仓库 B 的笔记')
    const versions=new SpaceVersions(new FileSpace(info.root))
    try { assert.equal(versions.versions(page.items.find(f=>f.name==='协作文档.md')!.id).length,3) } finally {versions.space.close()}
    writeFileSync(join(dir,'file-updates-result.json'),JSON.stringify({ok:true,ai,bi,imageId,spaceId:info.id,checks:['新建版本空间 IPC','两库新文件收录与 utilityProcess 加工','真实 UI 更新授权、准备及确认共享发布','B 保留 V1 字节与独立笔记','UI 版本比较及接纳','窄窗口无横向溢出','关闭再开自动追赶 V3']},null,2))
  } finally {if(!b.win.isDestroyed())b.win.close();await until(async()=>b.win.isDestroyed(),'B 窗口未关闭');await allClosed()}
}
