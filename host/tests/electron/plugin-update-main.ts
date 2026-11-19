import '../../src/main/index'
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { libraryOf } from '../../src/main/libraries'
import { localPackages, selectCapturePackage } from '../../src/main/plugin-packages'
import { PresetApplications } from '../../src/plugin-packages/preset-applications'
import { pluginUpdates } from '../../src/main/plugin-updates'
import { callCore } from '../../src/main/core-client'
import { findSettingsSurface, settingsScript } from './settings-surface'
import type { CoreApi } from '../../src/shared/rpc'
const dir = process.env.UPDATE_CHECK_DIR!, phase = process.env.UPDATE_CHECK_PHASE!
const until = async (fn:()=>Promise<unknown>|unknown,label:string) => {
  for (let n=0;n<350;n++) { if(await fn()) return; await new Promise(r=>setTimeout(r,100)) }
  throw Error('等待失败：'+label)
}
void app.whenReady().then(async()=> {
  await until(()=>BrowserWindow.getAllWindows().some(w=>libraryOf(w.webContents)),'仓库窗口')
  const win = BrowserWindow.getAllWindows().find(w=>libraryOf(w.webContents))!
  const js = (code:string)=>win.webContents.executeJavaScript(code)
  const call = <K extends keyof CoreApi>(m:K,...a:Parameters<CoreApi[K]>)=>callCore(libraryOf(win.webContents)!.core,m,...a)
  await until(()=>js(`!!document.querySelector('[aria-label="打开命令面板"]')`),'界面')
  await until(async()=> (await call('plugins')).some(p=>p.id==='update-probe'&&p.enabled),'插件加载')
  const old = JSON.parse(readFileSync(join(dir,'old.json'),'utf8'))
  if (phase === 'first') {
    const lib=libraryOf(win.webContents)!, jobs=new PresetApplications(join(app.getPath('userData'),'preset-applications'))
    const task=jobs.start(lib.root,lib.id,{disabled:[],external:[{id:old.manifest.id,hash:old.hash,enabled:true}]},{title:'待接续',layout:{version:1,root:{type:'group',id:'main'},primary:'main',panels:{sidebar:true,inspector:true}}})
    const blocked=await pluginUpdates().preview(win.webContents.id,old.hash,readFileSync(join(dir,'next.rmplugin')))
    assert.ok(blocked.blockers.some(s=>s.includes('未完成的方案应用')))
    assert.ok(!blocked.blockers.some(s=>s.includes('套件')))
    jobs.cancel(lib.root,lib.id,task.id)

    const [id] = await call('ingest',[{type:'text',text:'更新后仍保留的正文'}])
    await call('put',id,'update-probe.note',{text:'更新后仍保留的插件备注'})
    writeFileSync(join(dir,'entity.txt'),id)
    win.webContents.send('menu:command','settings')
    await until(()=>findSettingsSurface(win),'设置窗口')
    const s = (code:string)=>settingsScript(win,code)
    await until(()=>s(`!!document.querySelector('.settings-nav-scroll')`),'设置导航')
    await s(`[...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.trim()==='套件与插件包').click()`)
    await until(()=>s(`!!document.querySelector('[data-package-id="update-probe"]')`),'安装包列表')
    // 仅代办原生文件选择；更新按钮、确认和重载都走真实界面。
    process.env.CAPTURE_DIR = dir
    selectCapturePackage(join(dir,'next.rmplugin'))
    await s(`[...document.querySelector('[data-package-id="update-probe"]').querySelectorAll('button')].find(b=>b.textContent==='更新…').click()`)
    await until(()=>s(`!!document.querySelector('[data-action="update-package"]')`),'更新确认')
    assert.equal(await s(`document.querySelector('[data-action="update-package"]').disabled`),false,await s(`document.body.innerText`))
    assert.ok(await s(`document.body.innerText.includes('保持停用') && document.body.innerText.includes('保持启用')`))
    writeFileSync(join(dir,'preview.png'),(await findSettingsSurface(win)!.webContents.capturePage()).toPNG())
    await s(`document.querySelector('[data-action="update-package"]').click()`)
    await until(()=>{const job=pluginUpdates().read();if(job?.error)throw Error(job.error);return job?.phase==='complete'},'更新完成')
    await until(()=>findSettingsSurface(win),'重载后设置恢复')
    await until(()=>s(`!!document.querySelector('[data-plugin-update-phase="complete"]')`),'更新结果反馈')
    writeFileSync(join(dir,'result.png'),(await findSettingsSurface(win)!.webContents.capturePage()).toPNG())
  }
  const binding = (await call('externalPlugins')).find(p=>p.manifest.id==='update-probe')!
  assert.equal(binding.manifest.version,'1.1.0'); assert.equal(binding.enabled,true)
  assert.equal(localPackages().list().some(p=>p.hash===old.hash),false)
  assert.equal(existsSync(localPackages().directory(old.hash)),false)
  const db = new Database(join(dir,'closed.library','library.db'),{readonly:true,fileMustExist:true})
  const closed = JSON.parse(db.prepare("SELECT value FROM config WHERE key='externalPlugins'").pluck().get() as string)[0]
  db.close()
  assert.equal(closed.hash,binding.hash); assert.equal(closed.enabled,false)
  const id = readFileSync(join(dir,'entity.txt'),'utf8')
  assert.equal((await call('get',[id]))[0].blocks['update-probe.note'].data.text,'更新后仍保留的插件备注')
  writeFileSync(join(dir,phase+'-result.json'),JSON.stringify({phase,updatedViaSettings:true,activeLibraryReload:true,closedLibraryStaysDisabled:true,pluginDataPreserved:true,oldPackageDeleted:true}))
  app.exit(0)
}).catch(e=>{console.error(e);app.exit(1)})
