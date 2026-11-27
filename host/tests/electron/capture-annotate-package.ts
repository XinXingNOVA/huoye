import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { packageActionScope, afterPackageAction, finishPackageInstall } from './capture-settings'
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
interface Tools {js(code:string):Promise<any>;log(label:string,value:unknown):void;shot(name:string):Promise<void>}
export async function annotatePackageFlow(win:BrowserWindow,dir:string,{js,log,shot}:Tools) {
  const fixture=JSON.parse(readFileSync(join(dir,'..','legacy.json'),'utf8'))
  const lib=()=>libraryOf(win.webContents)!
  const call=<K extends keyof CoreApi>(method:K,...args:Parameters<CoreApi[K]>)=>callCore(lib().core,method,...args)
  const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message)}
  const until=async(test:()=>Promise<unknown>,message:string)=>{for(let i=0;i<150;i++){try{if(await test())return}catch{}await wait(100)}throw new Error(message)}
  const click=async(selector:string,text:string)=>{
    selector = await packageActionScope(js, selector, text)
    check(await js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),`按钮不可用 ${text}`)
    await wait(150);await afterPackageAction(js,selector,text)
  }
  const settings=async()=>{
    win.webContents.send('menu:command','settings')
    await until(()=>js(`!!document.querySelector('.settings-library .package-row[data-package-id="annotate"] input')`),'未显示批注包设置')
  }
  const running=async(enabled:boolean)=>until(async()=>!lib().reloading&&(await call('info')).assembly.plugins.find(p=>p.id==='annotate')?.enabled===enabled&&await js(`!!document.querySelector('.package-settings')`),'批注启停未完成')
  const unchanged=async()=>check(JSON.stringify(await call('get',[fixture.target,fixture.quote]))===JSON.stringify(fixture.records),'旧摘录内容、序号或引用改变')
  const open=async(id:string)=>{
    await js(`document.querySelector('.tab')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await click('.sidebar .nav-item','全部');await wait(400)
    await until(()=>js(`!!document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]')`),'未找到卡片')
    await js(`document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  }
  if(process.env.CAPTURE_FLOW==='annotatepackageresume') {
    await settings()
    const row=(await js('window.bridge.packages.list()')).find((p:any)=>p.manifest.id==='annotate')
    check(row&&!row.installed&&!row.enabled,'重启擅自重装批注')
    await unchanged();await shot('annotate-package-4-restart.png')
    selectCapturePackage(join(__dirname,'plugins/annotate.rmplugin'))
    await click('.package-heading button','安装套件或插件包…')
    await until(()=>js(`!!document.querySelector('.package-dialog')`),'安装预览未打开')
    await finishPackageInstall(js,true)
    await click('.settings-foot button','应用并重新加载');await running(true)
    await unchanged();await open(fixture.quote)
    await until(()=>js(`!!document.querySelector('.tab-pane:not(.hidden) .text-mark')`),'重装后原文标记未恢复')
    await shot('annotate-package-5-restored.png')
    log('批注重启与重装通过',['未装回','旧摘录保留','界面安装和统一启用','原文定位和标记恢复']);return
  }
  check((await call('plugins')).find(p=>p.id==='annotate')?.external,'批注不是外部包')
  await unchanged();await open(fixture.quote)
  await until(()=>js(`!!document.querySelector('.tab-pane:not(.hidden) .text-mark')`),'旧摘录原文标记未恢复')
  await shot('annotate-package-1-legacy.png')
  const other=await openLibrary(join(dir,'..','disabled-library'),{show:false})
  try{check(!(await callCore(other.core,'plugins')).find(p=>p.id==='annotate')?.enabled,'旧停用选择丢失')}finally{other.win.close()}
  const source=join(dir,'新图片.jpg')
  await sharp({create:{width:600,height:400,channels:3,background:'#d85842'}}).jpeg().toFile(source)
  const [image]=await call('ingest',[{type:'file',path:source}])
  await until(async()=>!!(await call('get',[image]))[0].blocks.thumb,'新图片未加工')
  await open(image);await until(()=>js(`!!document.querySelector('.tab-pane:not(.hidden) .region-layer')`),'图片选区层未显示')
  await js(`(()=>{const layer=document.querySelector('.tab-pane:not(.hidden) .region-layer'),r=layer.getBoundingClientRect();const at=(x,y)=>({bubbles:true,pointerId:1,button:0,clientX:r.left+r.width*x,clientY:r.top+r.height*y});for(const [type,x,y] of [['pointerdown',.1,.2],['pointermove',.5,.6],['pointerup',.5,.6]])layer.dispatchEvent(new PointerEvent(type,at(x,y)))})()`)
  await until(()=>js(`!!document.querySelector('.region-input input')`),'新选区未出现批注输入')
  await js(`(()=>{const input=document.querySelector('.region-input input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'外部批注的新区域');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
  let local=''
  await until(async()=>{const ids=(await call('query',{where:[{op:'eq',kind:'anchor',field:'target',value:image}]})).ids;local=ids[0];return local&&!!(await call('get',[local]))[0].blocks.thumb},'外部裁图或缩略图未完成')
  const b=(await call('get',[local]))[0].blocks
  const crop=await sharp(join(lib().root,String(b.still.data.path))).metadata()
  check(crop.width===240&&crop.height===160,'新图裁剪尺寸不符')
  check(readFileSync(await call('locateOriginalFile',{id:image,kind:'file',field:'path'})).equals(readFileSync(source)),'原文件字节改变')
  await until(()=>js(`(()=>{const r=document.querySelector('.tab-pane:not(.hidden) .region.selected');return r&&r.getBoundingClientRect().width>0&&getComputedStyle(r).borderTopStyle==='solid'})()`),'新区域标记未绘出')
  await wait(300);await shot('annotate-package-2-region.png')
  await call('trash',[image]);check((await call('get',[local]))[0].deletedAt,'依附回收失败')
  await call('undo');await unchanged()
  await settings();await js(`document.querySelector('.settings-library .package-row[data-package-id="annotate"] input').click()`)
  await click('.settings-foot button','应用并重新加载');await running(false);await unchanged()
  await settings();await click('.package-row[data-package-id="annotate"] button','卸载…');await click('.package-dialog button','卸载插件')
  await until(async()=>!(await js('window.bridge.packages.list()')).find((p:any)=>p.manifest.id==='annotate')?.installed,'批注包未卸载')
  await unchanged();await shot('annotate-package-3-uninstalled.png')
  writeFileSync(join(dir,'result.json'),JSON.stringify({image,local,crop:{width:crop.width,height:crop.height}}))
  log('批注迁包通过',['旧 v1 摘录接续','旧停用保留','原文定位','新图片导入','界面圈选','utilityProcess 裁图和缩略图','原文件字节','回收撤销','界面停用和卸载'])
}
