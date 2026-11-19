import { settingsScript } from './settings-surface'
import assert from 'node:assert/strict'
import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePackage, digest } from '../../src/plugin-packages/archive'
import { encodeSuite } from '../../src/plugin-packages/suites'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { showLauncher } from '../../src/main/launcher'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { createVault, previewCreation, pendingCreations, resumeCreation } from '../../src/main/library-creation'
import { PresetCatalog } from '../../src/plugin-packages/preset-catalog'
import type { WorkbenchLayout } from '../../src/shared/workbench-layout'

export async function runLibraryCreationCapture(first: BrowserWindow, dir: string) {
  let launcher = first
  const pause = () => new Promise(r => setTimeout(r, 100))
  const until = async (test: () => Promise<unknown> | unknown, name: string) => { for (let n = 0; n < 180; n++) { try { if (await test()) return } catch {} await pause() } throw new Error('建库验证未就绪：' + name) }
  const js = (code: string) => launcher.webContents.executeJavaScript(code)
  const click = async (selector: string, label: string) => { assert(await js('(()=>{const b=[...document.querySelectorAll(' + JSON.stringify(selector + ' button') + ')].find(b=>b.textContent===' + JSON.stringify(label) + ');if(!b||b.disabled)return false;b.click();return true})()'), label); await pause() }
  const settings = (code: string) => settingsScript(launcher, code)
  const settingsClick = async (selector: string, label: string) => { assert(await settings('(()=>{const b=[...document.querySelectorAll(' + JSON.stringify(selector + ' button') + ')].find(b=>b.textContent===' + JSON.stringify(label) + ');if(!b||b.disabled)return false;b.click();return true})()'), label); await pause() }
  const input = async (index: number, value: string) => { await js('(()=>{const e=document.querySelectorAll(".launcher-card .field-text")[' + index + '];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(value) + ');e.dispatchEvent(new Event("input",{bubbles:true}))})()'); await pause() }
  const reopen = async () => { launcher = showLauncher(false); await until(() => js('!!document.querySelector(".launcher-home-actions")'), '开始页'); await js('window.dispatchEvent(new Event("focus"))') }
  const parent = realpathSync(dir), flag = join(parent, 'fail-plugin'), counter = join(parent, 'plugin-boots.txt')
  const presetId = 'suite:creation-suite:organize', flow = process.env.CAPTURE_FLOW!
  const result = join(dir, flow + '-result.json')
  const shot = async (name: string, win = launcher) => writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG())
  const readyLibrary = async (root: string) => {
    await until(() => openLibraries().find(l => l.root === root), '仓库打开')
    const lib = openLibraries().find(l => l.root === root)!
    await until(() => lib.win.webContents.executeJavaScript('!!globalThis.__creationHost'), '方案插件界面')
    await until(() => lib.win.webContents.executeJavaScript('window.bridge.pluginPresets.pending().then(p=>!p)'), '工作台接续完成')
    const ws: any = await lib.win.webContents.executeJavaScript('window.bridge.loadWorkspace(' + JSON.stringify(lib.id) + ')')
    assert.equal(ws.editors.root.type, 'split'); assert(ws.tabs.some((t: any) => t.type === 'file-spaces'))
    return lib
  }
  try {
    assert(process.env.RM_USER_DATA)
    await until(() => js('!!document.querySelector(".launcher-home-actions")'), '初始开始页')
    if (flow === 'creationresume') {
      const saved = JSON.parse(readFileSync(join(dir, 'creation-resume.json'),'utf8'))
      assert.equal(pendingCreations()[0].id, saved.id)
      rmSync(flag, { force: true })
      await until(() => js('document.querySelectorAll("[data-creation-id]").length===1'), '重启接续列表')
      await js('document.querySelector(".launcher-recoveries summary").click()')
      await click('.launcher-recoveries', '继续创建')
      const lib = await readyLibrary(saved.root)
      assert.equal(lib.id, saved.libraryId)
      assert.equal(pendingCreations().length, 0)
      const count = readFileSync(counter,'utf8').split('\n').filter(Boolean).length
      assert.equal(count, saved.boots + 1, '重试只启动一次目标插件')
      await shot('creation-resumed.png',lib.win)
      writeFileSync(result, JSON.stringify({ ok: true })); return
    }
    const layout: WorkbenchLayout = { version: 1, root: { type: 'split', id: 'split', direction: 'columns', ratio: 0.6, first: { type: 'group', id: 'main' }, second: { type: 'group', id: 'side' } }, primary: 'main', panels: { sidebar: true, inspector: false }, contents: {
      main: { items: [{ kind: 'page', type: 'collection', target: { presetId: 'all' } }], active: 0 },
      side: { items: [{ kind: 'page', type: 'file-spaces', target: {} }], active: 0 }
    } }
    const bytes = encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'creation-probe', title: '建库验证', description: '临时回归', author: 'test', version: '1.0.0', uiFeatures: ['window-surfaces-v1'], entries: { core: 'core.mjs', ui: 'ui.mjs' } }), new Map([
      ['core.mjs', Buffer.from('import{existsSync,appendFileSync}from"node:fs";appendFileSync(' + JSON.stringify(counter) + ',"boot\\n");if(existsSync(' + JSON.stringify(flag) + '))throw new Error("simulated creation failure");export const blocks=[];export const plugin={id:"creation-probe",blocks};')],
      ['ui.mjs', Buffer.from('export const plugin={id:"creation-probe",windowProviders:[{id:"creation-probe.provider",order:1,Component:({host,children})=>{globalThis.__creationHost=host;return children}}]};')]
    ]))
    const manifest = suiteManifestSchema.parse({ formatVersion: 1, id: 'creation-suite', title: '创建演示', description: '', version: '1.0.0', packages: [{ id: 'creation-probe', version: '1.0.0', file: 'probe.rmplugin', hash: digest(bytes) }], presets: [{ id: 'organize', title: '整理工作台', plugins: [{ id: 'creation-probe', title: '建库验证', hash: digest(bytes) }, { id: 'text', title: '文字' }], layout }] })
    const file = join(dir,'creation.rmsuite'); writeFileSync(file, encodeSuite(manifest, new Map([['probe.rmplugin',bytes]])))
    await shot('launcher-home.png')
    assert.equal(await js('!!document.querySelector(".launcher-create")'),false)
    await click('.launcher-home-actions','创建')
    const nativeDialog = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [parent] })) as typeof nativeDialog
    try { await click('.launcher-create','选择位置…') } finally { dialog.showOpenDialog = nativeDialog }
    assert.equal(await js('document.querySelector("#launcher-name").value'),'')
    assert((await js('document.querySelector(".launcher-location").textContent')).includes(parent),'先选目录也显示所选路径')
    await shot('launcher-location-without-name.png')
    await input(0,'按方案创建')
    assert((await js('document.querySelector(".launcher-location").textContent')).includes(join(parent,'按方案创建')),'填写名称后显示完整目标')
    await shot('launcher-create.png')
    await click('.launcher-create','更多方案…')
    await click('.starting-preset','安装套件…')
    await until(() => settings('!!document.querySelector(".application-settings")'), '安装设置')
    selectCapturePackage(file); await settingsClick('.application-settings','安装套件或插件包…')
    await until(() => settings('!!document.querySelector("[data-suite-status=ready]")'), '套件预览')
    await settings('document.querySelector("[data-action=install-packages]").click()')
    await until(() => settings('!!document.querySelector("[data-suite-status=installed]")'), '安装结果')
    await until(() => js('document.querySelector(".starting-nav-item.active")?.textContent.includes("整理工作台")'), '安装后候选方案')
    await settingsClick('.package-dialog','用此方案新建仓库 →')
    await until(() => js('!!document.querySelector(".starting-layout")'), '方案就绪')
    await shot('launcher-presets.png')
    launcher.setSize(780,540); await pause()
    assert(await js('document.querySelector(".launcher-preset-page footer button").getBoundingClientRect().bottom <= innerHeight'), '窄窗口确认按钮可见')
    await shot('launcher-presets-narrow.png')
    launcher.setSize(1100,700); await pause()
    assert(await js('getComputedStyle(document.querySelector(".launcher-recent")).display !== "none"'), '宽窗口保留近期仓库')
    await shot('launcher-presets-wide.png')
    launcher.setSize(860,560); await pause()
    // 显式版本选择参与预演；布局调整不能重置它。
    await js('document.querySelector(".starting-preview summary").click()')
    await js('(()=>{const e=document.querySelector(".starting-version select");e.value=e.options[1].value;e.dispatchEvent(new Event("change",{bubbles:true}))})()')
    await until(() => js('!!document.querySelector(".launcher-preset-page footer button:not(:disabled)")'), '版本重新预检')
    assert(await js('document.querySelector(".starting-preview").open'), '调整版本后详情保持展开')
    // 返回不确认候选；再进入时沿用已确认的默认方案，表单仍在。
    await click('.launcher-back','← 返回新建仓库')
    assert.equal(await js('document.querySelector("#launcher-name").value'),'按方案创建')
    assert(await js('document.querySelector(".launcher-starters [aria-pressed=true]")?.textContent === "空白底座"'))
    await click('.launcher-create','更多方案…')
    await click('.starting-catalog','整理工作台含布局')
    await until(() => js('!!document.querySelector(".starting-layout")'), '候选布局')
    await js('document.querySelector(".starting-layout input").click()')
    await until(() => js('!!document.querySelector(".launcher-preset-page footer button:not(:disabled)")'), '布局重新预检')
    await click('.launcher-preset-page','确认选择此方案')
    await click('.launcher-create','更多方案…')
    assert.equal(await js('document.querySelector(".starting-layout input").checked'),false,'确认后的布局选项保留')
    await js('document.querySelector(".starting-layout input").click()')
    await until(() => js('!!document.querySelector(".launcher-preset-page footer button:not(:disabled)")'), '布局重新预检')
    await click('.launcher-preset-page','确认选择此方案')
    await until(() => js('!document.querySelector(".launcher-create-btn").disabled'), '确认后允许创建')
    await shot('creation-preview.png')
    await click('.launcher-primary-card','创建并打开')
    const root = join(parent,'按方案创建'), lib = await readyLibrary(root)
    assert.equal(readFileSync(counter,'utf8'),'boot\n','首次直接装配，不能先默认启动再重载')
    assert.equal((await callCore(lib.core,'plugins')).find(p=>p.id==='creation-probe')?.enabled,true)
    // 新仓库真实导入，核验 utilityProcess 与文件空间初始化仍可用。
    const path = join(parent,'new.txt'); writeFileSync(path,'created-library-import-probe')
    const imported = await callCore(lib.core,'importToLibrary',[{ type:'file', path }], { requestId: 'creation-import-test' })
    assert(imported)
    assert.equal(pendingCreations().length,0)
    assert.equal(existsSync(join(root,'.creation.json')),false)
    const conflict = await createVault({ parent,name:'按方案创建' },{ show:false }); assert('error' in conflict)
    await shot('creation-workbench.png',lib.win)
    await reopen()
    const schemes = new PresetCatalog(app.getPath('userData'))
    const p = schemes.get(presetId), choice = { id:p.id,revision:p.revision,layout:true,versions:[] }
    const bad = schemes.users.save('缺包',[{ id:'not-installed',title:'未安装' }])
    const missing = previewCreation({ id:bad.id,revision:bad.revision })
    assert(missing.issues.length)
    const invalid = await createVault({ parent,name:'缺包不得创建',preset:{ id:bad.id,revision:bad.revision },previewRevision:missing.revision },{ show:false })
    assert('error' in invalid); assert(!existsSync(join(parent,'缺包不得创建')))
    const old = previewCreation(choice)
    schemes.users.save('使目录可见但不改变当前方案',[])
    // 用错误基线模拟确认期间安装变化，必须在创建目录之前拒绝。
    assert('error' in await createVault({ parent,name:'过期不得创建',preset:choice,previewRevision:'stale' },{ show:false }))
    assert(!existsSync(join(parent,'过期不得创建')))
    // 非共享空间在创建前即被拒绝。
    const own = (await callCore(lib.core,'listFileSpaces'))[0]
    const privateResult = await createVault({ parent,name:'独享不得关联',spaceRoot:own.root },{ show:false })
    assert('error' in privateResult); assert(!existsSync(join(parent,'独享不得关联')))
    // 默认创建不继承刚安装的外部插件。
    const defaultResult = await createVault({ parent,name:'默认仓库' },{ show:false }); assert('ok' in defaultResult)
    assert(!(await callCore(openLibraries().find(l=>l.root===join(parent,'默认仓库'))!.core,'externalPlugins')).some(p=>p.manifest.id==='creation-probe'&&p.enabled))
    await reopen()
    // 先打开仍保留选择和数据；取消只移除意图，不删除已经初始化的仓库。
    writeFileSync(flag,'fail')
    const basicFailure = await createVault({ parent,name:'先打开',preset:choice,previewRevision:old.revision },{ show:false })
    assert('error' in basicFailure && basicFailure.recovery)
    assert('ok' in await resumeCreation(basicFailure.recovery.id,{show:false},true))
    const basicLib = openLibraries().find(l=>l.root===join(parent,'先打开'))!
    assert.equal((await callCore(basicLib.core,'externalPlugins'))[0].enabled,true)
    assert.equal((await callCore(basicLib.core,'plugins')).find(p=>p.id==='creation-probe')?.enabled,false)
    const kept = await callCore(basicLib.core,'importToLibrary',[{type:'file',path}],{requestId:'basic-import-test'})
    assert(kept.saved.length)
    await reopen()
    const cancelFailure = await createVault({ parent,name:'取消接续保留',preset:choice,previewRevision:old.revision },{ show:false })
    assert('error' in cancelFailure && cancelFailure.recovery)
    await js('window.bridge.creation.dismiss('+JSON.stringify(cancelFailure.recovery.id)+')')
    assert(existsSync(join(parent,'取消接续保留','library.db')))
    assert.equal(pendingCreations().length,0)
    // 故意使方案插件加载失败；留下同一仓库与任务，跨应用重启接续。
    const failed = await createVault({ parent,name:'待接续',preset:choice,previewRevision:old.revision },{ show:false })
    assert('error' in failed && failed.recovery)
    const jobs = pendingCreations(); assert.equal(jobs.length,1)
    const jobFile = join(app.getPath('userData'),'library-creations',jobs[0].id+'.json')
    const job = JSON.parse(readFileSync(jobFile,'utf8'))
    assert(existsSync(join(job.root,'library.db')))
    await reopen()
    await until(() => js('document.querySelectorAll("[data-creation-id]").length===1'),'失败记录')
    await js('document.querySelector(".launcher-recoveries summary").click()')
    await shot('creation-pending.png')
    writeFileSync(join(dir,'creation-resume.json'),JSON.stringify({ id:job.id,root:job.root,libraryId:job.libraryId,boots:readFileSync(counter,'utf8').split('\n').filter(Boolean).length }))
    writeFileSync(result,JSON.stringify({ ok:true }))
  } catch(e) {
    console.error('[creation capture]',e)
    await shot('creation-failed.png').catch(()=>{})
    process.exitCode=1
  } finally { app.quit() }
}
