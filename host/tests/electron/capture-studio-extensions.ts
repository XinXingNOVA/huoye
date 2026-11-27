import { createHash } from 'node:crypto'
import { localRuntimes } from '../../src/main/runtime-settings'
import { executable, encodeHeader, inspectRuntime, type RuntimeManifest } from '../../src/platform/runtime-package'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { workbenchContentWindow, workbenchSessionWindows } from '../../src/main/auxiliary-windows'
import type { PackagePreview } from '../../src/shared/external-plugins'
import { until } from './theme-settings'

export async function studioExtensionsFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!
  win.show()
  const js = (code: string, target = win) => target.webContents.executeJavaScript(code)
  const ready = () => until(() => js("!!document.querySelector('[aria-label=打开设置]')").catch(() => false), '工作台未就绪')
  await ready()
  const target = process.platform + '-' + process.arch as RuntimeManifest['target']
  const runtimes = localRuntimes()
  for (const [version, text] of [['1','selected'],['2','unselected']]) {
    const bytes = Buffer.from(text)
    const programs = ['studio-probe','undeclared-probe']
    const files = programs.map(name => ({path:executable(name,target),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}))
    const path = join(dir,'fixture-'+version+'.hyruntime')
    writeFileSync(path, Buffer.concat([encodeHeader({id:'studio-runtime',version,target,programs,files}),bytes,bytes]))
    const {digest} = await inspectRuntime(path)
    await runtimes.install(path,digest)
    if (version === '1') runtimes.setEnabled(digest,true)
  }
  const packs: PackagePreview = await js('window.bridge.packages.previewFiles(' + JSON.stringify([join(dir,'studio.hyplugin'), join(dir,'engine.hyplugin')]) + ')')
  await js('window.bridge.packages.install(' + JSON.stringify(packs.token) + ')')
  const disabled = (await callCore(lib.core, 'plugins')).filter(p => !p.external && p.chosen).map(p => p.id)
  await js('window.bridge.packages.apply(' + JSON.stringify({disabled, changes: packs.items.map(p => ({hash:p.hash, enabled:true}))}) + ')')
  await Promise.all([once(win.webContents, 'did-finish-load', { signal: AbortSignal.timeout(20000) }), reloadLibrary(lib)])
  await ready()
  await callCore(lib.core,'ingest',['sample.png', 'second.png'].map(name => ({ type:'file', path:join(dir,name) })))
  await until(async () => (await callCore(lib.core, 'query', { has: ['image'] })).ids.length === 2, '两张测试图尚未就绪')
  const browse = (name: string) => js(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.trim()===${JSON.stringify(name)})?.click()`)
  const probe = (id: string) => `document.querySelector('[data-probe="${id}"]')`
  const click = (id: string, w = win) => js(probe(id) + '?.click()', w)
  await until(async () => { await browse('Studio Wall'); return js(probe('layout') + "?.textContent==='large'") }, '预设布局未生效')
  await browse('Studio Page')
  await until(() => js('!!'+probe('compute')), '未显示计算页面')
  await click('compute')
  await until(() => js(probe('result') + "?.textContent==='5'"), '常驻能力未返回校验后的结果')
  await click('bad-value')
  await until(() => js(probe('result') + "?.textContent.includes('[CAPABILITY_INVALID_OUTPUT]')"), '无返回值的服务未报告契约错误')
  await click('tool')
  await until(() => js(probe('read') + '?.checkVisibility()'), '侧栏工具未显示')
  await click('read')
  await until(async () => {
    const src = await js(probe('image') + "?.getAttribute('src')")
    if (src?.startsWith('Error:')) throw Error(src)
    return js(probe('image') + '?.naturalWidth===32')
  }, '侧栏未读到缩略图')
  const old = await js(probe('image')+'.src')
  await click('hide')
  await until(() => js('fetch('+JSON.stringify(old)+').then(r=>r.status===404)'), '隐藏工具未释放图片')
  const imageBytes = [...readFileSync(join(dir, 'clipboard.png'))]
  async function pasteOnBody(w: BrowserWindow) {
    return js(`(() => {
      document.activeElement?.blur()
      if (document.activeElement !== document.body) throw Error('焦点未落在页面空白处')
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(${JSON.stringify(imageBytes)})], 'clipboard.png', {type:'image/png'}))
      return document.body.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:data}))
    })()`, w)
  }
  const testDrop = async (w: BrowserWindow) => {
    const el = probe('drop')
    await js(`(() => {
      const target=${el}, page=target.closest('[data-tab-content]')
      const transfer=new DataTransfer(); transfer.items.add(new File(['transient'], 'outside.txt'))
      const send=(node, type)=>node.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer}))
      send(page,'dragenter'); send(page,'dragover'); send(target,'dragover'); send(target,'drop')
    })()`, w)
    await until(() => js(probe('result') + "?.textContent==='outside.txt' && !document.querySelector('.drop-overlay')", w), '瞬态接收或浮层清理失败')
  }
  await testDrop(win)
  assert.equal(await pasteOnBody(win), true, '主窗口空白处的粘贴被宿主接管')
  await click('viewer')
  await until(() => js('!!'+probe('passive')), '缺少只读叠加层')
  await js("[...document.querySelectorAll('.viewer-bar button')].find(b=>b.textContent==='Second tool')?.click()")
  await until(() => js('!!'+probe('second')+' && !!'+probe('toolbar')+' && !'+probe('first')+' && !!'+probe('passive')+"?.closest('[inert]')"), '叠加层未完成互斥切换')
  const position = (label: string) => js("document.querySelector('.image-viewer-position')?.textContent===" + JSON.stringify(label))
  await until(() => position('1 / 2'), '图片队列未就绪')
  const arrow = (keyCode: string) => {
    win.webContents.sendInputEvent({type:'keyDown', keyCode})
    win.webContents.sendInputEvent({type:'keyUp', keyCode})
  }
  win.focus()
  arrow('Right')
  await until(() => position('2 / 2'), '右方向键未切到下一张图')
  assert(await js('!!' + probe('second') + ' && !!' + probe('toolbar')), '连续翻图丢失已选工具')
  arrow('Escape')
  await until(() => js('!' + probe('toolbar')), '未退出工具模式')
  arrow('Left')
  await until(() => position('1 / 2'), '左方向键未切回上一张图')
  assert(await js('!' + probe('first') + ' && !' + probe('second')), '翻图重新开启了已关闭的工具')
  await browse('Studio Page')
  await click('float')
  const contentWindow = () => {
    const found = workbenchSessionWindows(win).windows.find(w => w.id.startsWith('content:'))
    return found && workbenchContentWindow(win,found.id)
  }
  await until(() => !!contentWindow(), '独立小窗未打开')
  const child = contentWindow()!
  await until(() => js('!!'+probe('drop'),child), '小窗未挂载接收面')
  await testDrop(child)
  assert.equal(await pasteOnBody(child), true, '独立小窗空白处的粘贴被宿主接管')
  await click('compute',child)
  await until(() => js(probe('result') + "?.textContent==='5'",child), '小窗能力调用失败')
  assert.equal((await callCore(lib.core,'query',{has:['file']})).ids.length,2)
  win.focus()
  await browse('Studio Wall')
  await until(() => js(probe('layout') + '?.checkVisibility()'), '主窗普通集合页未显示')
  assert.equal(await pasteOnBody(win), false, '普通集合页未接管空白处粘贴')
  await until(async () => (await callCore(lib.core,'query',{has:['file']})).ids.length === 3, '普通集合页粘贴的图片未收录')
  writeFileSync(join(dir,'studio-pass.json'), JSON.stringify({fileCount:3, transientImports:0, collectionImports:1, windows:2, width:32, count:5}))
}
