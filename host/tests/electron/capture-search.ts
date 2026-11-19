// 分层搜索端到端回归：仅在指定的临时库中，通过公共 CoreApi 准备数据，界面操作验证查询。
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannelMain, type BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import type { CoreApi, RpcResponse } from '../../src/shared/rpc'
import type { Query } from '../../src/shared/query'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
interface Tools {
  js(code: string): Promise<any>
  log(label: string, value: unknown): void
  shot(name: string): Promise<void>
  click(selector: string, text: string): Promise<boolean>
}

export async function scopedSearchFlow(win: BrowserWindow, dir: string, { js, log, shot, click }: Tools) {
  const lib = libraryOf(win.webContents)!
  const { port1, port2 } = new MessageChannelMain()
  lib.core.postMessage({ type: 'connect' }, [port2])
  let next = 0
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  port1.on('message', ({ data }: { data: RpcResponse }) => {
    const p = pending.get(data.id)
    if (!p) return
    pending.delete(data.id)
    if ('error' in data) p.reject(new Error(data.error))
    else p.resolve(data.result)
  })
  port1.start()
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>): Promise<Awaited<ReturnType<CoreApi[K]>>> =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      port1.postMessage({ id, method, args })
    })
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const select = async (selector: string, value: string) => {
    check(await js(`(() => {const e=${pane}.querySelector(${JSON.stringify(selector)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`), `缺少选择器 ${selector}`)
    await wait(400)
  }
  const type = async (selector: string, value: string) => {
    check(await js(`(() => {const e=${pane}.querySelector(${JSON.stringify(selector)});if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`), `缺少输入框 ${selector}`)
    await wait(400)
  }
  const search = async (value: string) => { await type('.search-input', value); await wait(450) }
  const ids = () => js(`[...${pane}.querySelectorAll('.card')].map(c=>c.dataset.entityId).sort()`)
  const expectIds = async (expected: string[], message: string) => {
    const found = await ids()
    check(JSON.stringify(found) === JSON.stringify([...expected].sort()), `${message}：${JSON.stringify(found)}`)
  }
  const open = async (id: string) => {
    check(await js(`(() => {const c=${pane}.querySelector('[data-entity-id="${id}"]');c?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return !!c})()`), '找不到素材卡片')
    await wait(1500)
  }
  const back = async () => { await js(`document.querySelector('.tab.active .tab-x').click()`); await wait(500) }
  try {
    const fields = [{ id: 'ftitle', title: '片名', type: 'text' }, { id: 'fdirector', title: '导演', type: 'text' }, { id: 'fyear', title: '年份', type: 'number' }]
    const tpl = await call('create', { template: { title: '影视资料', fields } })
    const kind = `tpl:${tpl}`
    const a = await call('create', { text: { content: '# 甲资料\n共同词留白' }, note: { text: '共同词留白笔记' }, tags: { values: ['收藏'] }, [kind]: { ftitle: '花样年华', fdirector: '王家卫', fyear: 2000 } })
    const b = await call('create', { text: { content: '# 乙资料\n别的正文' }, note: { text: '共同词留白' }, tags: { values: ['其他'] }, [kind]: { ftitle: '王家卫访谈', fdirector: '另一位导演', fyear: 2020 } })
    await wait(700)
    await search('共同词')
    await expectIds([a, b], '全文结果')
    await select('.search-scope', 'text'); await expectIds([a], '限定正文')
    check(!await js(`!!${pane}.querySelector('.search-field')`), '单字段仍需额外选择')
    await open(a)
    check(await js(`${pane}.querySelectorAll('.reader-page mark').length>0`), '正文搜索未高亮')
    await back()
    await select('.search-scope', 'note'); await expectIds([a, b], '限定笔记')
    check(await js(`[...${pane}.querySelectorAll('.card-snippet-label')].every(e=>e.textContent==='笔记')`), '笔记范围混入正文摘要')
    await open(a)
    check(!await js(`${pane}.querySelectorAll('.reader-page mark').length`), '笔记搜索误高亮正文')
    await back()
    check(await click('.sidebar .nav-item', '收藏'), '没有标签筛选')
    await wait(600); await expectIds([a], '标签筛选与笔记搜索取交集')
    await click('.filter-clear', '清除筛选'); await wait(500)
    await select('.search-scope', kind); await search('王家卫')
    await expectIds([a, b], '模板全部文字字段')
    check(await js(`${pane}.querySelector('.search-field').options.length===3`), '把数字字段列进全文范围')
    await select('.search-field', 'fdirector'); await expectIds([a], '限定导演字段')
    check(await js(`${pane}.querySelector('.card-snippet-label').textContent==='影视资料 · 导演'`), '未显示模板与字段')
    await shot('search-scope-1-field.png')
    win.setSize(960, 650); await wait(700)
    const bounds = await js(`(() => {const bar=${pane}.querySelector('.toolbar').getBoundingClientRect();return [...${pane}.querySelectorAll('.toolbar button,.search-controls select,.search-input')].every(e=>{const r=e.getBoundingClientRect();return r.left>=bar.left&&r.right<=bar.right+1&&r.bottom<=bar.bottom+1})})()`)
    check(bounds, '窄窗口搜索控件超出工具栏')
    await shot('search-scope-2-narrow.png')
    win.setSize(1440,900); await wait(400)
    // 运行中改模板：选择保持稳定的 ID，摘要使用新名字。
    await call('put', tpl, 'template', { title: '影片资料', fields: fields.map(f=>f.id==='fdirector'?{...f,title:'创作者'}:f) })
    await wait(800)
    check(await js(`${pane}.querySelector('.search-field').selectedOptions[0].textContent==='创作者'`), '字段改名未更新选择器')
    check(await js(`${pane}.querySelector('.card-snippet-label').textContent==='影片资料 · 创作者'`), '字段改名后摘要缓存未更新')
    await call('run','fields','changeType',{template:tpl,field:'fdirector',type:'number'}); await wait(800)
    await expectIds([], '字段改类型后应零结果')
    check(await js(`${pane}.querySelector('.search-field').selectedOptions[0].textContent.includes('不可搜索')`), '失效字段没有提示')
    await call('undo'); await wait(800); await expectIds([a], '撤销字段改类型')
    // 本机工作区：临时范围、字段与词一并恢复。
    await wait(600); win.webContents.reload(); await wait(2500)
    check(await js(`${pane}.querySelector('.search-scope').value===${JSON.stringify(kind)}&&${pane}.querySelector('.search-field').value==='fdirector'&&${pane}.querySelector('.search-input').value==='王家卫'`), '刷新未恢复分层搜索')
    await expectIds([a], '刷新后结果')
    await click('.toolbar button','另存为视图'); await type('.name-input','导演资料')
    await js(`${pane}.querySelector('.name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
    await wait(700)
    check(await js(`${pane}.querySelector('.filter-bar').textContent.includes('创作者')`), '保存条件未显示')
    await select('.search-scope','note'); await search('共同词'); await expectIds([a], '保存视图与临时范围组合')
    await click('.toolbar button','更新视图'); await wait(700)
    const views = await call('query',{scope:'all',has:['view']})
    const saved = (await call('get',views.ids)).find(v=>v.blocks.view.data.title==='导演资料')!.blocks.view.data.query as Query
    check(saved.search?.length===2&&saved.search[0].field==='fdirector'&&saved.search[1].kind==='note', '更新视图改变原范围')
    await search('不存在'); await expectIds([], '叠加不存在的词')
    await js(`${pane}.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await wait(500); await expectIds([a], 'Esc 清空后仍保留视图条件')
    await shot('search-scope-3-saved.png')
    log('分层搜索、筛选、模板变化、摘要、窄窗口与保存恢复通过', {a,b,query:saved})

    // 新文件真正拖入运行中的应用：文字在 utilityProcess 提取，随后限定 PDF 正文搜索。
    await click('.sidebar .nav-item','全部'); await wait(500)
    const cups=['/usr/sbin/cupsfilter','/usr/bin/cupsfilter'].find(existsSync)
    check(cups,'需要 cupsfilter 生成测试 PDF')
    const txt=join(dir,'scope-input.txt'),pdf=join(dir,'分层搜索.pdf')
    writeFileSync(txt,['First page body','Second page needlefinal'].join('\f'))
    writeFileSync(pdf,execFileSync(cups!,['-m','application/pdf',txt],{stdio:['ignore','pipe','ignore']}))
    const at=await js(`(() => {const r=${pane}.querySelector('.collection').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
    const dbg=win.webContents.debugger;dbg.attach('1.3')
    try { for(const type of ['dragEnter','dragOver','drop']) await dbg.sendCommand('Input.dispatchDragEvent',{type,...at,data:{items:[],files:[pdf],dragOperationsMask:1}}) } finally { dbg.detach() }
    let pdfId: string | undefined
    for(let i=0;i<30;i++) {
      pdfId=(await call('query',{search:[{kind:'pdftext',text:'needlefinal'}]})).ids[0]
      if(pdfId)break
      await wait(200)
    }
    check(pdfId,'新 PDF 导入或文字提取失败')
    await call('put',pdfId!,'tags',{values:['needlefinal']})
    await call('put',pdfId!,'pdfreading',{page:1,offset:0,lastRead:Date.now()})
    await select('.search-scope','tags'); await search('needlefinal'); await expectIds([pdfId!],'PDF 标签搜索')
    await open(pdfId!)
    check(await js(`${pane}.querySelector('.pdf-page-jump').textContent.trim().startsWith('1')`),'标签命中错误跳到 PDF 正文')
    check(!await js(`${pane}.querySelector('.textLayer mark')`),'标签搜索误高亮 PDF 正文')
    await back()
    await select('.search-scope','pdftext'); await expectIds([pdfId!],'PDF 正文搜索')
    await open(pdfId!)
    check(await js(`${pane}.querySelector('.pdf-page-jump').textContent.trim().startsWith('2')`),'PDF 正文未跳至命中页')
    check(await js(`!!${pane}.querySelector('.pdf-page[data-page="2"] mark')`),'PDF 命中未高亮')
    await shot('search-scope-4-pdf.png')
    log('新 PDF 导入、限定正文跳页和标签范围不跳页通过',{pdfId})
    log('分层搜索验证全部通过',true)
  } catch(error) {await shot('search-scope-error.png');throw error}
  finally {port1.close()}
}
