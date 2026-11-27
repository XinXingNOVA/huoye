import '../../src/main/index'
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { libraryOf } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
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
    const snapshot = await js('window.bridge.packages.inventory()')
    assert.ok(snapshot.versions[old.hash].tasks.length && snapshot.versions[old.hash].libraries.length === 2)
    jobs.cancel(lib.root,lib.id,task.id)

    const [id] = await call('ingest',[{type:'text',text:'更新后仍保留的正文'}])
    await call('put',id,'update-probe.note',{text:'更新后仍保留的插件备注'})
    writeFileSync(join(dir,'entity.txt'),id)
    win.webContents.send('menu:command','settings')
    await until(()=>findSettingsSurface(win),'设置窗口')
    const s = (code:string)=>settingsScript(win,code)
    await until(()=>s(`!!document.querySelector('.settings-nav-scroll')`),'设置导航')
    const navigate = async (label: string) => {
      await s(`[...document.querySelectorAll('.settings-nav-scroll button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
    }
    const libraryTile = '.settings-library [data-package-id="update-probe"]'
    const appTile = '.application-settings [data-package-id="update-probe"]'
    await navigate('功能与方案')
    await until(() => s(`!!document.querySelector('${libraryTile} input')?.checkVisibility()`), '本库启停开关')
    assert.equal(await s(`document.querySelectorAll('${libraryTile} input[type=checkbox]').length`), 1)
    await s(`document.querySelector('${libraryTile} input').click()`)
    await s(`document.querySelector('${libraryTile} input').click()`)
    assert.equal(await s(`document.querySelector('${libraryTile} select').value`), old.hash)
    // 先暂存一项无关的启停，使后续的安装回执必须与草稿合并。
    const other = await s(`[...document.querySelectorAll('.settings-library [data-plugin-id]')].find(el=>el.dataset.pluginId!=='update-probe' && el.querySelector('input:not(:disabled)')?.checkVisibility()).dataset.pluginId`)
    const otherInput = '.settings-library [data-plugin-id="' + other + '"] input'
    const original = await s(`document.querySelector('${otherInput}').checked`)
    await s(`document.querySelector('${otherInput}').click()`)
    await navigate('套件与插件包')
    await until(()=>s(`!!document.querySelector('${appTile}')?.checkVisibility()`),'安装包列表')
    const surface = findSettingsSurface(win)!
    const drop = await s(`(() => {const b=document.querySelector('.plugin-suites .primary').getBoundingClientRect();return {x:b.x+4,y:b.y+4}})()`)
    surface.webContents.debugger.attach('1.3')
    try {
      for (const type of ['dragEnter','dragOver','drop']) await surface.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
        type, ...drop, data: { items: [], files: [join(dir,'probe.hyplugin')], dragOperationsMask: 1 }
      })
    } finally { surface.webContents.debugger.detach() }
    await until(()=>s(`!!document.querySelector('[data-install-group=version] [data-install-status=ready]')`),'拖入安装预览')
    await s(`document.querySelector('[data-action=install-packages]').click()`)
    await until(()=>s(`!!document.querySelector('[data-action=stage-installed]:enabled')`),'安装后交给当前仓库')
    await s(`document.querySelector('[data-action=stage-installed]').click()`)
    await until(()=>s(`!!document.querySelector('${libraryTile}[data-package-version="1.1.0"]')?.checkVisibility()`),'按精确版本暂存')
    assert.equal(await s(`document.querySelector('${otherInput}').checked`), !original)
    assert.equal((await call('externalPlugins')).find(p => p.manifest.id === old.manifest.id)?.hash, old.hash)
    await s(`[...document.querySelectorAll('.settings-foot button')].find(b=>b.textContent.trim()==='还原更改').click()`)
    await navigate('套件与插件包')
    await until(()=>s(`!!document.querySelector('.package-cleanup-bar button')?.checkVisibility()`),'闲置旧版清理入口')
    await s(`document.querySelector('.package-cleanup-bar button').click()`)
    assert.equal(await s(`document.querySelectorAll('.package-clean-row').length`), 2)
    await s(`[...document.querySelectorAll('.package-clean-row')].find(l=>l.textContent.includes('0.7.0')).querySelector('input').click()`)
    await s(`document.querySelector('.package-dialog-actions .danger').click()`)
    await until(()=>s(`document.querySelector('.package-dialog')?.innerText.includes('已清理 1 个版本')`),'选择性清理')
    await s(`document.querySelector('.package-dialog-actions button').click()`)
    const remaining = localPackages().list().filter(p=>p.manifest.id===old.manifest.id).map(p=>p.manifest.version).sort()
    assert.deepEqual(remaining,['0.7.0','0.8.0','1.0.0','1.1.0'])
    const free = localPackages().list().find(r=>r.manifest.id===old.manifest.id && r.manifest.version==='0.7.0')!
    const cleanupRequest = () => js(`window.bridge.packages.cleanup([${JSON.stringify(free.hash)}])`)
    const pending = jobs.start(lib.root,lib.id,{disabled:[],external:[{id:old.manifest.id,hash:free.hash,enabled:true}]},{title:'待接续',layout:{version:1,root:{type:'group',id:'main'},primary:'main',panels:{sidebar:true,inspector:true}}})
    assert.equal((await cleanupRequest()).skipped[0].hash, free.hash)
    jobs.cancel(lib.root,lib.id,pending.id)
    const closedPath=join(dir,'closed.library'), moved=join(dir,'offline.library')
    renameSync(closedPath,moved)
    try { assert.equal((await cleanupRequest()).skipped[0].hash,free.hash) }
    finally { renameSync(moved,closedPath) }
    await navigate('功能与方案'); await navigate('套件与插件包')
    await js("window.bridge.language.set('en')")
    await until(()=>s(`!!document.querySelector('input[aria-label="Search plugins"]')`), '英文插件目录')
    for (const [width, preset, scheme] of [[760,'huoye-standard','light'],[960,'huoye-standard','dark'],[1280,'celadon-study','light']] as const) {
      surface.setSize(width,720)
      await js(`window.bridge.appearance.change('application',{action:'select',id:'${preset}'})`)
      if (preset === 'huoye-standard') await js(`window.bridge.appearance.change('application',{action:'colorMode',value:'${scheme}'})`)
      await until(()=>s(`document.documentElement.dataset.theme === '${preset}' && document.documentElement.dataset.scheme === '${scheme}'`),'小窗主题同步')
      assert.ok(await s(`[...document.querySelectorAll('.plugin-tiles,.plugin-filters')].filter(el=>el.checkVisibility()).every(el=>el.scrollWidth <= el.clientWidth + 4)`), '窄宽度目录横向溢出')
    }
    await js("window.bridge.language.set('zh-CN')")
    await until(()=>s(`!!document.querySelector('input[aria-label="搜索插件"]')`), '中文插件目录')
    await s("document.querySelector('.application-settings .plugin-state-filters').scrollIntoView({ block: 'start' })")
    await new Promise(resolve => setTimeout(resolve, 220))
    writeFileSync(join(dir,'catalog.png'),(await surface.webContents.capturePage()).toPNG())
    await s(`document.querySelector('${appTile} [data-action="plugin-details"]').focus()`)
    await s(`document.querySelector('${appTile} [data-action="plugin-details"]').click()`)
    await until(()=>s(`document.querySelector('.plugin-drawer [data-version="1.0.0"]')?.innerText.includes('closed.library')`),'关闭且停用的仓库仍然占用此版')
    writeFileSync(join(dir,'versions.png'),(await surface.webContents.capturePage()).toPNG())
    surface.focus()
    surface.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
    surface.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
    await until(()=>s(`!document.querySelector('.plugin-drawer') && !!document.querySelector('${appTile}')?.checkVisibility()`),'Esc 关闭详情并保留设置')
    assert.ok(await s(`document.activeElement.matches('${appTile} [data-action="plugin-details"]')`),'焦点回到插件卡片')
    await s(`document.querySelector('${appTile} [data-action="plugin-details"]').click()`)
    await s(`[...document.querySelector('.plugin-drawer [data-version="1.0.0"]').querySelectorAll('button')].find(b=>b.textContent.includes('迁移到')).click()`)
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
