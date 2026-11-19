// PDF 续读与摘录端到端检查：只在 CAPTURE_FLOW=pdfnotes 的临时库运行。
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import Database from 'better-sqlite3'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
interface Tools {
  js(code: string): Promise<any>
  log(label: string, value: unknown): void
  shot(name: string): Promise<void>
  click(selector: string, text: string): Promise<boolean>
  key(k: string, mods?: string): Promise<unknown>
}
export async function pdfNotesFlow(win: BrowserWindow, dir: string, { js, log, shot, click, key }: Tools) {
  const cups = ['/usr/sbin/cupsfilter', '/usr/bin/cupsfilter'].find(existsSync)
  if (!cups) throw new Error('PDF 摘录验证需要 cupsfilter')
  const db = new Database(join(process.env.LIBRARY_PATH!, 'library.db'), { readonly: true })
  db.prepare('ATTACH DATABASE ? AS derived').run(join(process.env.LIBRARY_PATH!, 'derived.db'))
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const blocks = (id: string, kind: string) => {
    const r = db.prepare('SELECT data FROM block WHERE entity_id = ? AND kind = ? UNION ALL SELECT data FROM derived.block WHERE entity_id = ? AND kind = ?').get(id, kind, id, kind) as { data: string } | undefined
    return r ? JSON.parse(r.data) : undefined
  }
  const quotes = () => (db.prepare("SELECT b.entity_id, b.data FROM block b JOIN entity e ON e.id=b.entity_id WHERE b.kind='anchor' AND (json_extract(b.data,'$.type')='PDF摘录' OR json_extract(b.data,'$.locator.provider')='pdf.quote') AND e.deleted_at IS NULL").all() as { entity_id: string; data: string }[]).map((r) => (() => { const a = JSON.parse(r.data); const location = a.locator?.data; return { id: r.entity_id, ...a, ...(location ? { ...location, page: location.fragments[0].page } : {}) } })())
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const cardOpen = async (id: string) => {
    check(await js(`(() => {const c=${pane}.querySelector('[data-entity-id="${id}"]');c?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return !!c})()`), '卡片未找到')
    await wait(1800)
  }
  const go = async (page: number, offset = 0) => {
    await js(`(() => {const s=${pane}.querySelector('.pdf-scroll');const p=s.querySelector('.pdf-page[data-page="${page}"]');s.scrollTop=p.offsetTop + p.offsetHeight*${offset} - 12})()`)
    await wait(1200)
  }
  const position = () => js(`(() => { const s=${pane}.querySelector('.pdf-scroll');const y=s.scrollTop+12;const pages=[...s.querySelectorAll('.pdf-page')];const p=pages.filter(p=>p.offsetTop<=y+1).at(-1)||pages[0];return {page:Number(p.dataset.page),offset:(y-p.offsetTop)/p.offsetHeight,marks:document.querySelectorAll('[data-pdf-mark],[data-content-mark]').length,scroll:s.scrollTop} })()`)
  const close = async () => { await js(`document.querySelector('.tab.active .tab-x').click()`); await wait(600) }
  const selectText = async (page: number, cross = false, lastPage = page + 1) => {
    const result = await js(`(() => {
      window.getSelection().removeAllRanges();
      const spans=(n)=>[...${pane}.querySelectorAll('.pdf-page[data-page="'+n+'"] .textLayer span')].filter(s=>s.firstChild?.nodeType===3 && s.textContent.trim());
      const a=spans(${page});const b=${cross} ? spans(${lastPage}) : a;
      const i=a.findIndex(s=>s.textContent.includes('留'));
      const first=${cross} ? a.at(-1) : a[i];const last=${cross} ? b[1] : a[i+1];
      if (!first||!last) return {error:'文字层未就绪',a:a.length,b:b.length};
      const r=document.createRange();r.setStart(first.firstChild,0);r.setEnd(last.firstChild,last.firstChild.length);
      window.getSelection().addRange(r);last.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return {text:r.toString()};
    })()`)
    check(!result.error, JSON.stringify(result))
    await wait(180)
    check(await js(`!!document.querySelector('.content-selection-menu')`), '未出现摘录操作')
    return result
  }
  try {
    if (process.env.CAPTURE_FLOW === 'pdfresume') {
      const id = (db.prepare("SELECT entity_id FROM block WHERE kind='file' AND json_extract(data,'$.name')='续读与摘录.pdf'").get() as {entity_id:string}).entity_id
      let p = await position()
      check(p.page===2 && Math.abs(p.offset-.35)<.01 && quotes().length===2, '重启应用未恢复进度或摘录')
      log('完全退出再启动后的续读', {position:p,record:blocks(id,'pdfreading')})
      // 已打开的 PDF：从摘录返回，继续阅读，再打开同一个摘录仍要重新定位。
      const quote=quotes().find((q)=>q.page===2)
      await key('1','meta'); await click('.sidebar .nav-item','批注'); await wait(700); await cardOpen(quote.id)
      check((await position()).page===2, '从摘录返回失败')
      await go(3,.2)
      await key('1','meta'); await wait(300); await cardOpen(quote.id)
      check((await position()).page===2, '重复打开同一摘录未重新定位')
      await go(2,.4)
      await key('1','meta'); await click('.sidebar .nav-item','PDF'); await wait(700)
      await js(`(() => {const e=${pane}.querySelector('.search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'thirdpageonly');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
      await wait(1000); await cardOpen(id)
      p=await position(); check(p.page===3, '搜索没有优先定位到命中页')
      check(await js(`!!${pane}.querySelector('.pdf-page[data-page="3"] mark')`), '搜索文字没有标出')
      log('重复摘录定位与搜索跳页', p)
      await shot('pdf-notes-4-search.png')
      await go(1); await go(2); await go(3)
      await selectText(1,true,3)
      await click('.content-selection-menu button','标记摘录'); await wait(800)
      check(quotes().some((q)=>q.fragments.length===3), '远离可视区的起始页没有包含在长摘录中')
      log('跨三页长选区保存', {pages:quotes().find((q)=>q.fragments.length===3).fragments.map((p:{page:number})=>p.page)})
      return
    }
    await click('.sidebar .nav-item', '全部'); await wait(500)
    // 新文件在 Electron utilityProcess 里经历 probe → still → text。
    const files = ['续读与摘录.pdf', '另一本.pdf'].map((name, i) => {
      const txt = join(dir, name+'.txt'), pdf = join(dir, name)
      writeFileSync(txt, [1,2,3].map((p) => [`Book ${i+1} page ${p} unique-${Date.now()} ${p===3?'thirdpageonly':''}`, ...Array.from({length:42}, (_, n) => `Page ${p} line ${n+1}: 留白的力量与阅读节奏。Study spacing and rhythm.`)].join('\n')).join('\f'))
      writeFileSync(pdf, execFileSync(cups, ['-m','application/pdf',txt], {stdio:['ignore','pipe','ignore']}))
      return pdf
    })
    const at = await js(`(() => { const r=${pane}.querySelector('.collection').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)} })()`)
    const dbg = win.webContents.debugger; dbg.attach('1.3')
    try { for (const type of ['dragEnter','dragOver','drop']) await dbg.sendCommand('Input.dispatchDragEvent', {type,...at,data:{items:[],files,dragOperationsMask:1}}) } finally { dbg.detach() }
    await wait(5500)
    const fileId = (name: string) => (db.prepare("SELECT entity_id FROM block WHERE kind='file' AND json_extract(data,'$.name')=?").get(name) as {entity_id:string}).entity_id
    const id = fileId('续读与摘录.pdf'), other = fileId('另一本.pdf')
    check(blocks(id,'pdf')?.pages === 3 && blocks(id,'pdftext')?.content.includes('留白') && blocks(id,'still'), '新 PDF 加工失败')
    log('新文件导入与加工', {id,pages:blocks(id,'pdf').pages,text:!!blocks(id,'pdftext'),cover:!!blocks(id,'still')})
    await cardOpen(id)
    await go(2,.3)
    check(blocks(id,'pdfreading')?.page===2, '没有保存阅读进度')
    await close(); await cardOpen(id)
    let p=await position(); check(p.page===2 && Math.abs(p.offset-.3)<.01, '关闭重开没有恢复页内进度')
    log('关闭重开恢复阅读位置', p)
    await go(2)
    await selectText(2)
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',bubbles:true}))`)
    await wait(200)
    check(!await js(`!!document.querySelector('.content-selection-menu')`), 'Escape 没有取消选文摘录')
    log('选择页中文字', await selectText(2))
    await click('.content-selection-menu button','添加批注')
    await wait(150)
    await js(`(() => {const e=document.querySelector('[aria-label="摘录批注"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'构图参考 #阅读');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await click('.selection-note-dialog button','保存批注'); await wait(1000)
    const quote=quotes()[0]; check(quote?.page===2 && quote.sourceHash===blocks(id,'file').hash, '摘录没有保存来源或页码')
    check(blocks(quote.id,'note')?.text==='构图参考' && blocks(quote.id,'tags')?.values.includes('阅读'), '摘录笔记或标签未保存')
    check(quote.quote.includes('留白') && (await position()).marks>0, '中文摘录或高亮失败')
    await shot('pdf-notes-1-highlight.png')
    // 缩放后用存下来的比例矩形检查实际框的位置。
    await click('.pdf-bar button','+'); await wait(1000)
    const alignment = await js(`(() => {const m=document.querySelector('[data-content-mark="${quote.id}"]');const p=${pane}.querySelector('.pdf-page[data-page="2"]');const a=m.getBoundingClientRect(),b=p.getBoundingClientRect();return {x:(a.left-b.left)/b.width,y:(a.top-b.top)/b.height,w:a.width/b.width,h:a.height/b.height}})()`)
    check(Math.abs(alignment.x-quote.fragments[0].rects[0].x)<.002 && Math.abs(alignment.y-quote.fragments[0].rects[0].y)<.002, '缩放后高亮错位')
    log('摘录笔记标签和缩放定位', {quote,alignment})
    await click('.content-quote-chip button','删除'); await wait(600)
    check(quotes().length===0, '删除摘录失败')
    win.webContents.send('menu:command', 'undo'); await wait(700)
    check(quotes().length===1 && (await position()).marks>0, '撤销没有恢复摘录高亮')
    await js(`(() => {const select=${pane}.querySelector('[aria-label=页面缩放]');select.value='fit';select.dispatchEvent(new Event('change',{bubbles:true}))})()`); await go(1,.75)
    log('跨页选择', await selectText(1,true))
    await click('.content-selection-menu button','标记摘录'); await wait(900)
    check(quotes().length===2 && quotes().some((q)=>q.fragments.length===2), '跨页摘录失败')
    await shot('pdf-notes-2-crosspage.png')
    // 读到第三页后，从摘录卡片打开仍应回到第二页。
    await go(3,.2); await close()
    await click('.sidebar .nav-item','批注'); await wait(700); await cardOpen(quote.id)
    p=await position(); check(p.page===2, '摘录卡片没有定位到原页')
    check(await js(`!!document.querySelector('[data-content-mark="${quote.id}"].selected')`), '打开摘录未选中高亮')
    log('摘录卡片返回原文', p)
    await click('.pdf-bar button','返回原文'); await wait(200)
    check(await js(`document.querySelector('.inspector').textContent.includes('构图参考')`), '原文检查器未列出摘录')
    await go(2,.35)
    await key('1','meta'); await wait(700)
    await click('.sidebar .nav-item','PDF'); await wait(700); await cardOpen(other)
    p=await position(); check(p.page===1, '另一份 PDF 继承了前一份进度')
    await close()
    await js(`(() => {const t=[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('续读与摘录'));t.click()})()`)
    await wait(1100)
    p=await position(); check(p.page===2 && Math.abs(p.offset-.35)<.01, '切换标签页丢失页内位置')
    // 保留旧的摘录打开请求再刷新，恢复时仍应采用之后的阅读位置。
    win.webContents.reload(); await wait(3500)
    p=await position(); check(p.page===2 && Math.abs(p.offset-.35)<.01, '刷新没有恢复持久化阅读位置')
    log('跨文件、切换标签、刷新后的续读', {position:p,record:blocks(id,'pdfreading')})
    await shot('pdf-notes-3-restored.png')
    log('PDF 阅读与摘录验证通过', {excerpts:quotes().length})
  } catch (error) { await shot('pdf-notes-error.png'); throw error }
  finally { db.close() }
}
