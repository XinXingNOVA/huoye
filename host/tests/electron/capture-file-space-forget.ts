import { FileSpace } from '../../src/storage/file-space'
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { findSettingsSurface, settingsScript, settingsSurface } from './settings-surface'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'

export async function fileSpaceForgetFlow(win: BrowserWindow, dir: string) {
  const lib = openLibraries().find(l => l.win === win)!
  const js = (code: string): Promise<any> => settingsScript(win, code)
  const until = async (fn: () => Promise<unknown>, label: string) => {
    for (let i=0;i<200;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,100)) }
    writeFileSync(join(dir,'forget-error.txt'),await (findSettingsSurface(win) ?? win).webContents.executeJavaScript('document.body.innerText')); throw new Error(label)
  }
  const click = (label: string, selector = 'button') => until(()=>js(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&e.textContent.trim()===${JSON.stringify(label)});if(!e||e.disabled)return false;e.click();return true})()`),'不能点击 '+label)
  const openLinks = async () => {
    await until(() => win.webContents.executeJavaScript("(()=>{const button=document.querySelector('[aria-label=打开设置]');if(!button)return false;button.click();return true})()"), '工作台未就绪')
    await until(async () => !!findSettingsSurface(win), '设置窗口未打开')
    await click('导入与空间', '.settings-library-nav button')
    await until(() => js("(()=>{const links=document.querySelector('.import-links');if(!links)return false;if(!links.open)links.querySelector('summary').click();return links.open})()"), '关联空间列表未展开')
  }
  const shot = async (name: string) => { await new Promise(r=>setTimeout(r,200)); writeFileSync(join(dir,name+'.png'),(await settingsSurface(win).webContents.capturePage()).toPNG()) }
  if (process.env.CAPTURE_FLOW === 'spaceforgetresume') {
    const saved=JSON.parse(readFileSync(join(dir,'forget-state.json'),'utf8'))
    assert(!(await callCore(lib.core,'listFileSpaces')).some(s=>s.id===saved.spaceId))
    const view=(await callCore(lib.core,'get',[saved.id]))[0]
    assert.equal(view.blocks.note.data.text,'空间删除后保留的笔记'); assert.equal(view.blocks.file.data.path,saved.reference)
    await openLinks()
    await until(()=>js("!!document.querySelector('.space-links')"),'重开设置未加载')
    assert(!await js("document.querySelector('.space-links').textContent.includes('可移除的测试空间')"))
    writeFileSync(join(dir,'spaceforgetresume-result.json'),JSON.stringify({ok:true}));return
  }
  const space=FileSpace.create(join(dir,'可移除的测试空间'),'shared')
  const embedded=(await callCore(lib.core,'listFileSpaces')).find(s=>s.embedded)!
  await callCore(lib.core,'linkFileSpace',space.root); await callCore(lib.core,'setDefaultFileSpace',space.id)
  const path=join(dir,'空间清理验证.png')
  await sharp({create:{width:180,height:120,channels:3,background:'#7397b3'}}).png().toFile(path)
  const [id]=await callCore(lib.core,'ingest',[{type:'file',path}])
  await until(async()=>!!(await callCore(lib.core,'get',[id]))[0].blocks.image,'新 PNG 未完成 utilityProcess 加工')
  const reference=String((await callCore(lib.core,'get',[id]))[0].blocks.file.data.path)
  await callCore(lib.core,'put',id,'note',{text:'空间删除后保留的笔记'})
  await callCore(lib.core,'setDefaultFileSpace',embedded.id)
  await openLinks()
  const row="[...document.querySelectorAll('.space-link-row')].find(e=>e.textContent.includes('可移除的测试空间'))"
  await until(()=>js(`!!(${row})`),'关联记录未显示')
  await js(`([...(${row}).querySelectorAll('button')].find(b=>b.textContent==='解除关联…')).click()`)
  await click('保留数据并解除')
  await until(()=>js(`(${row})?.textContent.includes('已解除关联')`),'解除未完成')
  // 只删除此流程刚创建的临时测试空间，模拟用户已经手动删除目录。
  rmSync(space.root,{recursive:true}); assert(!existsSync(space.root))
  await click('移除记录…','.space-link-row button')
  await until(()=>js("document.querySelector('[aria-label=\"移除空间关联记录\"]')?.textContent.includes('1 项活跃素材')"),'移除预览未说明引用')
  await js("document.querySelector('[aria-label=\"移除空间关联记录\"]').scrollIntoView({block:'start'})")
  settingsSurface(win).setSize(980,760);await shot('forget-preview')
  await click('取消','[aria-label="移除空间关联记录"] button')
  assert((await callCore(lib.core,'listFileSpaces')).some(s=>s.id===space.id))
  await click('移除记录…','.space-link-row button');await click('仅移除记录')
  await until(()=>js(`!(${row})`),'名称未从设置移除')
  assert(!(await callCore(lib.core,'listFileSpaces')).some(s=>s.id===space.id))
  const view=(await callCore(lib.core,'get',[id]))[0]
  assert.equal(view.blocks.note.data.text,'空间删除后保留的笔记');assert.equal(view.blocks.file.data.path,reference)
  await shot('forget-complete')
  writeFileSync(join(dir,'forget-state.json'),JSON.stringify({spaceId:space.id,id,reference}))
  writeFileSync(join(dir,'spaceforget-result.json'),JSON.stringify({ok:true,checks:['真实新 PNG 导入加工','UI 解除关联后删除临时空间目录','移除预览及取消','UI 移除记录后设置名称消失','业务块与引用保留']}))
}
