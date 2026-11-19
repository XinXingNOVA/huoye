import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { executeUiCommand } from './capture-command'

export async function uiExtensionsFlow(win: BrowserWindow, dir: string, { js, shot }: { js(code: string): Promise<any>; shot(name: string): Promise<void> }) {
  const wait = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const page = (name: string) => `[data-extension-page="${name}"]`
  const action = (name: string, id: string) => `${page(name)} [data-extension-entry="demo-extension-contributor.${id}"] button`
  const count = (name: string) => js(`Number(document.querySelector('${page(name)} [data-extension-count]').textContent)`)
  const snapshot = async () => { await wait(500); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const open = async (name: string) => { await executeUiCommand(js, 'demo-extension-provider.open-' + name); await until(`!!document.querySelector('${page(name)}')`) }
  const activate = async (id: string) => { await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const failure = async (value: string) => {
    await js(`(()=>{const el=document.querySelector('${page('B')} select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}))})()`); await wait()
  }
  await until(`!!document.querySelector('.editor-group')`)
  if (process.env.CAPTURE_FLOW === 'uiextensionsmissing') {
    const states = await callCore(libraryOf(win.webContents)!.core, 'plugins')
    assert.equal(states.find(p => p.id === 'demo-extension-provider')?.enabled, false)
    assert.equal(states.find(p => p.id === 'demo-extension-contributor')?.enabled, true)
    await executeUiCommand(js, 'demo-extension-contributor.alive')
    await shot('extensions-provider-disabled.png')
  } else if (process.env.CAPTURE_FLOW === 'uiextensionsresume') {
    await open('A'); await click(action('A', 'add'))
    assert.equal(await count('A'), 1, '重新启用后有效贡献恢复')
    await shot('extensions-restored.png')
  } else {
    await open('A'); const a = (await snapshot()).active
    await click(action('A', 'add')); assert.equal(await count('A'), 1)
    assert.equal(await js(`document.querySelectorAll('${page('A')} [data-extension-entry]').length`), 2, '非法载荷和不匹配版本不得显示')
    await click(action('A', 'delayed'))
    await open('B'); const b = (await snapshot()).active
    await wait(600)
    assert.equal(await count('B'), 0, '异步动作不能改投新焦点')
    await activate(a); assert.equal(await count('A'), 11)
    // 本页动作在卸载后不能污染另一页；提供方负责自己实例的存活校验。
    await click(action('A', 'delayed'))
    await click(`[data-tab="${a}"] [aria-label="关闭标签页"]`)
    await activate(b); await wait(600); assert.equal(await count('B'), 0)
    await failure('sync'); await click(action('B', 'add'))
    await failure('async'); await click(action('B', 'add'))
    await failure('render')
    await until(`document.querySelector('${page('B')} [role=alert]')?.textContent.includes('demo-extension-contributor')`)
    assert(await js(`!!document.querySelector('${page('B')} select')`), '贡献渲染失败仍保留提供方页面')
    await failure('none'); await click(action('B', 'add')); assert.equal(await count('B'), 1, '出错组件不撤下其他动作')
    await shot('extensions-render-failure.png')
    await js(`[...document.querySelectorAll('${page('B')} button')].find(b=>b.textContent==='查看插件协作问题').click()`)
    await until(`!!document.querySelector('[data-extension-diagnostics]')`)
    await click('[data-extension-diagnostics] summary')
    const issues = await js(`document.querySelector('[data-extension-diagnostics]').textContent`)
    for (const text of ['demo-extension-contributor.future', 'demo-extension-contributor.invalid', '同步失败', '异步失败', '渲染失败']) assert(issues.includes(text), text)
    await js(`document.querySelector('[data-extension-diagnostics]').scrollIntoView({block:'start'})`); await wait()
    await shot('extensions-diagnostics.png')
    await click('[aria-label="关闭设置"]')
    const states = await callCore(libraryOf(win.webContents)!.core, 'plugins')
    assert(states.filter(p => p.id.startsWith('demo-extension-')).every(p => p.enabled), '贡献故障不撤下整插件')
  }
  await wait(700)
  writeFileSync(join(dir, process.env.CAPTURE_FLOW + '-result.json'), JSON.stringify({ ok: true }))
}
