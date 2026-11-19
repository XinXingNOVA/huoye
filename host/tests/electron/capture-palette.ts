import { executeUiCommand } from './capture-command'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
export async function paletteFlow(win: BrowserWindow, dir: string, chooseMenu: (label: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const call = <K extends keyof CoreApi>(m: K, ...a: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, m, ...a)
  const until = async (fn: () => Promise<unknown>) => { for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('色板加工未完成：'+JSON.stringify(await call('plugins'))) }
  const hash = localPackages().list().find(p=>p.manifest.id==='palette')!.hash
  const enable = async (enabled: boolean) => {
    await win.webContents.executeJavaScript(`window.bridge.packages.apply({disabled:[],changes:[{hash:${JSON.stringify(hash)},enabled:${enabled}}]})`)
    await reloadLibrary(libraryOf(win.webContents)!)
    await new Promise(r=>setTimeout(r,1200))
    await until(async()=> (await call('info')).assembly.plugins.some(p=>p.id==='palette' && p.enabled===enabled))
  }
  const file = join(dir,'color.png'); await sharp({create:{width:90,height:60,channels:3,background:'#ee1122'}}).png().toFile(file)
  await enable(false)
  const [id] = await call('ingest',[{type:'file',path:file}])
  const view = async()=> (await call('get',[id]))[0]
  await until(async()=> (await view()).blocks.thumb)
  assert.equal((await view()).blocks.palette,undefined)
  await enable(true)
  await until(async()=> (await view()).blocks.palette)
  const before = (await view()).blocks
  assert.ok((before.palette.data.colors as string[]).length)
  await enable(false)
  assert.deepEqual((await view()).blocks.palette.data,before.palette.data)
  const select = async () => {
    await executeUiCommand(js, 'host.view.all')
    await until(()=>js(`!!document.querySelector('[data-tab-focused="true"] [data-entity-id="${id}"]')`))
    await js(`document.querySelector('[data-tab-focused="true"] [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await until(()=>js(`!!document.querySelector('.inspector-layout-bar')`))
  }
  const has = (kind: string) => js(`!!document.querySelector('[data-inspector-section="block:${kind}"]')`)
  await select()
  assert.equal(await has('palette'),false,'休眠块应默认隐藏')
  assert.equal(await has('still'),false); assert.equal(await has('thumb'),false)
  chooseMenu('显示未启用插件的数据')
  await js(`document.querySelector('[aria-label="详情布局"]').click()`)
  await until(()=>has('palette'))
  assert.equal(await has('still'),false); assert.equal(await has('thumb'),false)
  await enable(false); await select()
  assert.equal(await has('palette'),true,'重载未保留显隐偏好')
  chooseMenu('隐藏未启用插件的数据')
  await js(`document.querySelector('[aria-label="详情布局"]').click()`)
  await until(async()=>!await has('palette'))
  assert.deepEqual((await view()).blocks.palette.data,before.palette.data,'隐藏修改了仓库数据')
  writeFileSync(join(dir,'inspector-visibility.png'),(await win.webContents.capturePage()).toPNG())
  const preview = await call('previewPluginDataCleanup',{pluginId:'palette',mode:'all'})
  assert.deepEqual(preview.blocked,[])
  await call('cleanupPluginData',{pluginId:'palette',mode:'all',token:preview.token})
  const after=(await view()).blocks
  assert.equal(after.palette,undefined);assert.equal(after.thumb.seq,before.thumb.seq);assert.equal(after.file.seq,before.file.seq)
  await enable(true);await until(async()=> (await view()).blocks.palette)
  writeFileSync(join(dir,'palette-result.json'),JSON.stringify({disabledImport:true,enabledCompute:true,disabledPreserves:true,cleanupIsolated:true,rebuild:true,supportBlocksHidden:true,inactiveTogglePersists:true}))
}
