// 数据核心回归：在真实核心进程中新收录，再停用全部可选插件检查基本访问与取回。
import { executeUiCommand } from './capture-command'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }

export async function dataCoreFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const click = async (selector: string, text: string) => {
    check(await js(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});e?.click();return !!e})()`), `缺少按钮 ${text}`)
    await wait(220)
  }
  const external = async (enabled: boolean) => {
    await js(`[...document.querySelectorAll('.package-choice > input:not(:disabled)')].filter(e=>e.checked!==${enabled}).forEach(e=>e.click())`)
  }
  const navigate = () => click('.sidebar .nav-item', '全部')
  const open = async (id: string) => {
    await navigate(); await wait(350)
    await js(`${pane}.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await wait(400)
  }
  const dropFile = async (path: string) => {
    const point = await js(`(() => {const r=${pane}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+120)}})()`)
    win.webContents.debugger.attach('1.3')
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: [path], dragOperationsMask: 1 } })
    } finally { win.webContents.debugger.detach() }
    await wait(650)
  }

  const source = join(dir, '原始资料.txt')
  writeFileSync(source, '文件正文来自本轮真实导入。\n这份原文件在插件停用后仍要能够取回。')
  await dropFile(source)
  const [file] = (await call('query', { has: ['file'] })).ids
  check(file, '真实拖入没有创建文件记录')
  const body = '# 核心保留的文字\n\n' + '这是一段需要完整保留的长文字。\n'.repeat(100) + '正文结束标志 boundary-end'
  const [text] = await call('ingest', [{ type: 'text', text: body }])
  const template = await call('create', { template: { title: '研究资料模板', fields: [{ id: 'fremark', title: '研究说明', type: 'text' }] } })
  await call('put', file, `tpl:${template}`, { fremark: '模板插件停用后也要保留' })
  await call('put', file, 'note', { text: '附加笔记保留' })
  await call('put', file, 'tags', { values: ['研究'] })
  const anchor = await call('create', { anchor: { target: file, type: '文本区间', quote: '文件正文来自本轮真实导入。' } })
  const groups = await call('create', { tagGroups: { groups: [{ id: 'research', title: '用途', tags: ['研究'] }] } })
  const view = await call('create', { view: { title: '研究视图', query: { has: [`tpl:${template}`] }, layout: 'masonry', options: {} } })
  for (let i = 0; i < 30 && !(await call('get', [file]))[0].blocks.body; i++) await wait(100)
  check((await call('get', [file]))[0].blocks.body?.data.content, '真实核心进程没有读出新文件正文')
  await wait(300)
  const ids = [file, text, anchor, template, groups, view]
  const original = (await call('get', ids)).map(v => ({ id: v.id, blocks: Object.fromEntries(Object.entries(v.blocks).filter(([k]) => !['body', 'links', 'place'].includes(k))) }))

  win.webContents.send('menu:command', 'settings'); await wait(400)
  await external(false)
  check(await js(`(() => {const inputs=[...document.querySelectorAll('[data-plugin-group="core"] [data-plugin-id] input')];return inputs.length===2 && inputs.every(e=>e.disabled)})()`), '基础模块仍可停用')
  await js(`[...document.querySelectorAll('[data-plugin-id] input:not(:disabled)')].filter(e=>e.checked).forEach(e=>e.click())`)
  await wait(100); await shot('data-1-settings.png')
  await click('.settings-foot button', '应用并重新加载'); await wait(2200)
  check((await call('plugins')).filter(p => p.enabled).map(p => p.id).join(',') === 'file,view', '没有进入零可选插件状态')
  await navigate(); await wait(350)
  check(await js(`${pane}.querySelectorAll('.card').length===3`), '素材列表混入管理记录或丢失素材')
  const captions = await js(`[...${pane}.querySelectorAll('.card-caption')].map(e=>e.textContent)`)
  check(captions.every((s: string) => s && s !== '未命名'), '通用标题缺失')
  check(await js(`${pane}.querySelectorAll('.cover-pending').length===0`), '通用卡片仍是加载占位')
  await shot('data-2-records.png')
  check(JSON.stringify((await call('get', ids)).map(v => ({ id: v.id, blocks: Object.fromEntries(Object.entries(v.blocks).filter(([k]) => !['body', 'links', 'place'].includes(k))) }))) === JSON.stringify(original), '停用插件改动了原始数据')

  await open(text)
  check(await js(`${pane}.querySelector('.data-details').innerText.includes('boundary-end')`), '通用详情截断了正文')
  check(await js(`${pane}.querySelectorAll('textarea,input,[contenteditable="true"]').length===0`), '休眠正文可以直接编辑')
  check((await call('readContent', { id: text, kind: 'text', field: 'content' })).text === body, '读取服务与通用详情内容不一致')
  await shot('data-3-details.png')
  await executeUiCommand(js, 'host.action.preview'); await wait(220)
  check(await js(`document.querySelector('.preview-data').innerText.includes('boundary-end')`), '通用预览为空或截断')
  await shot('data-4-preview.png')
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await wait(100)
  await open(anchor)
  check(await js(`!!${pane}.querySelector('.data-reference')`), '原素材没有通用引用入口')
  await js(`${pane}.querySelector('.data-reference').click()`); await wait(350)
  check(await js(`${pane}.querySelector('.data-identity').textContent.includes('${file}')`), '引用没有跳转到原素材详情')
  check(await js(`${pane}.querySelector('.data-details').innerText.includes('模板插件停用后也要保留')`), '模板字段未显示')
  await shot('data-5-reference.png')

  const previousDownloads = app.getPath('downloads')
  app.setPath('downloads', dir)
  try {
    await click('.tab-pane:not(.hidden) .data-details header button', '取回数据…')
    await wait(200)
    check(await js(`document.querySelectorAll('.takeout-dialog').length===1 && document.querySelectorAll('.qa-backdrop').length===1`), '取回对话框重复嵌套')
    await shot('data-6-takeout.png')
    await click('.takeout-dialog .export-actions button', '取回')
    await wait(600)
    check(await js(`document.querySelector('.takeout-dialog').innerText.includes('已取回 3 条记录、1 个原文件')`), '界面取回没有完成')
    const out = await js(`document.querySelector('.takeout-dialog p.data-value').textContent`)
    const manifest = JSON.parse(readFileSync(join(out, 'records.json'), 'utf8'))
    check(readFileSync(join(out, manifest.files[0].copy)).equals(readFileSync(source)), '取回文件与原始输入不同')
    check(manifest.records.length === 3 && manifest.problems.length === 0, '取回记录不完整')
    await shot('data-7-takeout-result.png')
    await click('.takeout-dialog .export-actions button', '完成')
  } finally { app.setPath('downloads', previousDownloads) }

  await navigate(); await wait(250)
  const fresh = join(dir, '停用之后的新文件.bin'); writeFileSync(fresh, '基础模块仍能收录新文件')
  await dropFile(fresh)
  const added = (await call('query', { where: [{ op: 'eq', kind: 'file', field: 'name', value: '停用之后的新文件.bin' }] })).ids[0]
  check(added && readFileSync(await call('locateOriginalFile', { id: added, kind: 'file', field: 'path' }), 'utf8') === '基础模块仍能收录新文件', '停用可选插件后无法真实收录新文件')
  await call('trash', [file]); await wait(250)
  check((await call('query', { scope: 'trash' })).ids.includes(anchor), '停用插件后依附回收失败')
  await call('undo'); await wait(250)
  check(!(await call('get', [anchor]))[0].deletedAt, '会话撤销未恢复依附记录')
  await open(file)
  win.setSize(960, 720); await wait(250)
  check(await js(`${pane}.querySelector('.data-tab').scrollWidth <= ${pane}.querySelector('.data-tab').clientWidth + 1`), '窄窗口详情溢出')
  await shot('data-8-narrow.png')
  win.setSize(1440, 900)
  win.webContents.send('menu:command', 'settings'); await wait(400)
  await external(true)
  await js(`[...document.querySelectorAll('[data-plugin-id] input:not(:disabled)')].filter(e=>!e.checked).forEach(e=>e.click())`)
  await wait(100); await click('.settings-foot button', '应用并重新加载'); await wait(2200)
  check((await call('plugins')).every(p => p.enabled), '重新启用没有恢复插件')
  await open(text)
  check(await js(`!!${pane}.querySelector('.reader') && !${pane}.querySelector('.data-details')`), '重新启用后没有恢复专用打开方式')
  await call('patch', file, `tpl:${template}`, { fremark: '重新启用后可以编辑' })
  await call('undo')
  check((await call('get', [file]))[0].blocks[`tpl:${template}`].data.fremark === '模板插件停用后也要保留', '重新启用后编辑／撤销失败')
  await shot('data-9-reenabled.png')
  log('数据核心回归通过', { ids, added, checks: ['真实新文件拖入与正文加工', '基础模块及可选插件启停', '原始数据保持', '素材与管理记录分开浏览', '通用标题封面', '完整只读详情与预览', '引用跳转', '界面取回与字节比对', '停用后新文件收录', '依附回收与撤销', '窄窗口', '重新启用后的专用界面与编辑撤销'] })
}
