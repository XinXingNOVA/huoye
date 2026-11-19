import { executeUiCommand } from './capture-command'
// 表格 / 自定义字段插件协作回归：新临时库、公共命令、真实界面、启停和数据保留。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
interface Tools {
  js(code: string): Promise<any>
  log(label: string, value: unknown): void
  shot(name: string): Promise<void>
  click(selector: string, text: string): Promise<boolean>
  chooseMenu(label: string): void
}

export async function tablePluginsFlow(win: BrowserWindow, dir: string, { js: execute, log, shot, chooseMenu }: Tools) {
  const js = async (code: string) => {
    try { return await execute(code) } catch (error) { log('失败的界面操作', code); await shot('table-error.png'); throw error }
  }
  const click = (selector: string, text: string) => js(`(() => {
    const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if(!el || el.disabled) return false; el.click(); return true;
  })()`)
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  let pane = `document.querySelector('[data-tab-content]')`
  let tabId = ''
  const until = async (test: () => Promise<unknown>, message: string) => { for (let i=0;i<120;i++) { try { if(await test()) return } catch {} await wait(100) } throw Error(message) }
  const input = async (selector: string, value: string, enter = true) => {
    check(await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
      e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`), `缺少输入框 ${selector}`)
    await wait(100)
    if (enter) await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
    await wait(350)
  }
  const escape = async () => { await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(150) }
  const header = async (title: string) => {
    check(await click(`[data-tab-content="${tabId}"] .th-label`, title), `找不到表头 ${title}`)
    await wait(200)
  }
  const cell = async (index: number) => {
    await js(`${pane}.querySelector('.table-row').querySelectorAll('.td')[${index}].click()`)
    await wait(200)
  }
  const undo = async () => { await call('undo'); await wait(450) }
  const togglePlugin = async (title: string) => {
    const plugin = title === '表格' ? 'table' : 'fields'
    const wasEnabled = (await call('plugins')).find(p => p.id === plugin)!.enabled
    await executeUiCommand(js, 'host.setting.library.plugins')
    await until(() => js(`!!document.querySelector('.settings-section-card.active [data-plugin-id="${plugin}"] input')`), '设置插件尚未加载')
    await js(`document.querySelector('.settings-section-card.active [data-plugin-id="${plugin}"] input').click()`)
    await wait(150)
    check(await click('.settings-foot button', '应用并重新加载'), '缺少应用设置按钮')
    await until(async () => !libraryOf(win.webContents)?.reloading && (await call('plugins')).find(p => p.id === plugin)?.enabled !== wasEnabled && await js(`!!document.querySelector('[aria-label="关闭设置"]')`), '插件重载未完成')
    await wait(400)
    await js(`document.querySelector('[aria-label="关闭设置"]').click()`)
    await js(`document.querySelector('[data-tab="${tabId}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await wait(600)
  }
  if (process.env.CAPTURE_FLOW === 'tabletoolsfaults') {
    const expected = JSON.parse(readFileSync(join(dir, 'table-tools-expected.json'), 'utf8'))
    const { template, kind } = await call('run', 'fields', 'createTemplate', { title: '故障验证' }) as { template: string; kind: string }
    const { field } = await call('run', 'fields', 'addField', { template, title: '阶段', type: 'select' }) as { field: string }
    await call('admit', [expected.id], { has: [kind] })
    const { id: viewId } = await call('run', 'view', 'saveView', { title: '故障验证', query: { has: [kind] }, layout: 'table', options: {} }) as { id: string }
    await executeUiCommand(js, 'host.saved-view.' + viewId)
    await until(() => js(`!!document.querySelector('.table-scroller [role=alert]')`), '表头故障未隔离')
    await wait(700)
    tabId = await js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)}).then(w=>w.active)`)
    pane = `document.querySelector('[data-tab-content="${tabId}"]')`
    await header('阶段')
    check(await js(`${pane}.querySelectorAll('[role=alert]').length===2`), '菜单故障影响了表格')
    await cell(1); await click('.cell-popover .field-option.add', '+'); await input('.cell-popover .option-input', '不应写入')
    check(await js(`document.querySelector('.cell-popover [role=alert]')?.textContent.includes('探针选项失败')`), '贡献动作失败未呈现')
    check((await call('get', [expected.id]))[0].blocks[kind].data[field] === undefined, '失败动作仍写入了选项值')
    await escape()
    await shot('table-7-isolated.png')
    await executeUiCommand(js, 'host.setting.library.plugins')
    await until(() => js(`document.querySelector('[data-extension-diagnostics]')?.textContent.includes('探针选项失败')`), '缺少贡献来源诊断')
    await until(() => js(`!!document.querySelector('.settings-section-card.active [data-plugin-id="table"]')`), '插件诊断页尚未加载')
    await js(`document.querySelector('[data-extension-diagnostics]').open=true`)
    await shot('table-8-diagnostics.png')
    check((await call('plugins')).filter(p => ['table','fields','table-probe'].includes(p.id)).every(p => p.enabled), '局部故障撤下了整个插件')
    writeFileSync(join(dir, 'tabletoolsfaults-result.json'), JSON.stringify({ ok: true }))
    return
  }
  if (process.env.CAPTURE_FLOW === 'tabletoolsresume') {
    const expected = JSON.parse(readFileSync(join(dir, 'table-tools-expected.json'), 'utf8'))
    await executeUiCommand(js, 'host.saved-view.' + expected.viewId)
    // 隐藏页以 visibility 保活，getClientRects 仍非空；只检查命令打开的当前页。
    pane = `document.querySelector('[data-tab-content][data-tab-focused="true"]:not(.hidden)')`
    await until(() => js(`!!${pane}?.querySelector('.table-row') && !!${pane}?.querySelector('.th.add')`), '重开后表格未恢复')
    check(JSON.stringify((await call('get', [expected.id]))[0].blocks[expected.kind].data) === JSON.stringify(expected.data), '重开改写了原字段数据')
    check(expected.columns && expected.extraKind && expected.extraField, '重开验收缺少保存列配置')
    {
      const actual = await js(`[...${pane}.querySelectorAll('.th')].map(e=>e.textContent.trim())`)
      check(actual.slice(1,4).join('|') === expected.columnTitles.join('|'), '重开后选列／顺序没有接续')
      check(JSON.stringify((await call('get',[expected.viewId]))[0].blocks.view.data.options)===JSON.stringify(expected.columns), '保存视图中的列配置改变')
      check((await call('get',[expected.id]))[0].blocks[expected.extraKind]?.data[expected.extraField] === 7, '跨模板字段值没有保持')
    }
    await shot('table-6-reopened.png')
    writeFileSync(join(dir, 'tabletoolsresume-result.json'), JSON.stringify({ ok: true }))
    return
  }

  // 在真正的 utilityProcess 中导入全新文件，不借用日常素材库。
  const file = join(dir, '插件验证.md')
  writeFileSync(file, '# 插件验证\n这份素材用于检查模板编辑与插件启停。\n')
  const [id] = await call('ingest', [{ type: 'file', path: file }])
  await wait(900)
  check(!!(await call('get', [id]))[0]?.blocks.file, '新文件导入失败')

  const { template, kind } = await call('run', 'fields', 'createTemplate', { title: '协作验证' }) as { template: string; kind: string }
  const { id: viewId } = await call('run', 'view', 'saveView', { title: '协作验证', query: { has: [kind] }, layout: 'table', options: {} }) as { id: string }
  await executeUiCommand(js, 'host.saved-view.' + viewId)
  await until(() => js(`!!document.querySelector('.table-scroller .th.add')`), '表头贡献未加载')
  await wait(700)
  tabId = await js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)}).then(w=>w.active)`)
  pane = `document.querySelector('[data-tab-content="${tabId}"]')`
  for (const [title, type] of [['年份', '文本'], ['阶段', '单选'], ['评分', '评分'], ['看过', '复选框']]) {
    await header('＋')
    await input('.add-field input', title, false)
    check(await click('.add-field .field-option', type), `缺少字段类型 ${type}`)
    check(await click('.add-field button.small', '添加字段'), '缺少添加字段按钮')
    await wait(300)
  }
  await call('run', 'tags', 'update', { ids: [id], add: ['协作验证'] })
  check((await call('facet', 'tags', 'values')).some(t => t.value === '协作验证' && t.count === 1), '标签分面未接入')
  check((await call('query', { where: [{ kind: 'tags', field: 'values', op: 'eq', value: '协作验证' }] })).ids.includes(id), '标签筛选未接入')
  const fields = ((await call('get', [template]))[0].blocks.template.data.fields as { id: string; title: string }[])
  check(fields.length === 4, '连续添加字段覆盖了先前字段')
  const [year, phase, rating, seen] = fields.map(f => f.id)
  await call('admit', [id], { has: [kind] })
  await wait(450)
  const data = async () => (await call('get', [id]))[0].blocks[kind].data
  const def = async () => (await call('kinds')).find(k => k.id === kind)!
  await cell(1); await input('.cell-inline input', '2026')
  await cell(2)
  await click('.cell-popover .field-option.add', '+')
  await input('.cell-popover .option-input', '待办')
  await escape()
  await js(`${pane}.querySelector('.table-row .rating').querySelectorAll('.star')[3].click()`)
  await js(`${pane}.querySelector('.table-row input[type=checkbox]').click()`)
  await wait(300)
  check(JSON.stringify(await data()) === JSON.stringify({ [year]: '2026', [phase]: '待办', [rating]: 4, [seen]: true }), '格子编辑结果不符')
  log('表头与单元格', await data())
  await shot('table-1-filled.png')

  // 表头贡献执行更名、结构预演、转换及撤销。
  await header('年份'); await input('.field-menu input[aria-label="字段名称"]', '年度')
  check((await def()).fields[year].title === '年度', '字段改名没有保留 ID')
  await header('年度'); await click('.field-menu .field-option', '数字'); await wait(200)
  check((await data())[year] === '2026', '预演写入了数据')
  check(await js(`document.querySelector('.menu-confirm').textContent.includes('都能转换')`), '转换预演未显示影响')
  await shot('table-2-preview.png')
  await click('.menu-confirm button', '确认更改'); await wait(350)
  check((await data())[year] === 2026, '类型转换未执行')
  await undo(); check((await data())[year] === '2026', '转换撤销失败')
  await header('阶段'); await input('.option-row input', '完成')
  check((await data())[phase] === '完成', '选项改名未迁移值')
  await escape(); await undo()
  await header('阶段'); await js(`document.querySelector('.option-row .nav-x').click()`); await wait(350)
  check((await data())[phase] === undefined, '删除选项未移除值')
  await escape(); await undo()
  await header('年度'); await click('.field-menu button.danger', '删除字段'); await wait(150)
  check((await data())[year] === '2026', '删除字段预演写入数据')
  await click('.menu-confirm button.danger', '确认删除'); await wait(350)
  check(!(await def()).fields[year] && (await data())[year] === undefined, '字段未删除')
  await undo(); check((await data())[year] === '2026', '删除字段撤销未还原值')

  log('结构编辑与撤销', await data())
  const before = await data()
  await togglePlugin('自定义字段')
  check((await def()).dormant, '停用字段插件后定义没有休眠')
  check(JSON.stringify(await data()) === JSON.stringify(before), '停用字段插件丢失数据')
  check(await js(`!!${pane}.querySelector('.table-row') && !${pane}.querySelector('.th.add') && [...${pane}.querySelectorAll('.th-label')].every(b=>b.disabled) && !${pane}.querySelector('.td.editable, .table-row input, .table-row .star')`), '休眠表格仍可编辑')
  check(await js(`${pane}.querySelector('.table-row').textContent.includes('2026') && ${pane}.querySelector('.table-row').textContent.includes('待办')`), '休眠表格没有通用显示')
  check((await call('query', { has: [kind], where: [{ op: 'eq', kind, field: phase, value: '待办' }] })).ids.includes(id), '休眠数据不可查')
  let denied = false
  try { await call('run', 'fields', 'addOption', { template, field: phase, option: '无效' }) } catch { denied = true }
  check(denied, '停用后字段命令仍可写入')
  await shot('table-3-fields-off.png')

  await togglePlugin('自定义字段')
  check(!(await def()).dormant && await js(`!!${pane}.querySelector('.th.add')`), '重新启用未恢复扩展')
  await cell(2); await click('.cell-popover .field-option.add', '+'); await input('.cell-popover .option-input', '恢复后新增'); await escape()
  check((await data())[phase] === '恢复后新增', '重新启用后不能新建选项')
  await togglePlugin('表格')
  check(await js(`!!${pane}.querySelector('.grid-scroller') && !${pane}.querySelector('.table-scroller')`), '停用表格没有降级布局')
  await js(`${pane}.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await wait(300)
  check(await js(`!!document.querySelector('.inspector .template-block')`), '停用表格使字段检查器失效')
  // 表格关闭，字段插件仍能独立编辑；两者并非硬依赖。
  await click('.inspector .template-block .field-option', '待办'); await wait(300)
  check((await data())[phase] === '待办', '表格关闭后检查器无法编辑字段')
  check(await click('.inspector .template-head button', '编辑模板'), '缺少独立模板编辑入口')
  {
    await until(()=>js(`!!document.querySelector('.fields-editor-toolbar button')`),'独立模板编辑器未就绪')
    check(await click('.fields-editor-toolbar button','＋ 新增字段'),'缺少新增字段入口');await wait(100)
    await input('.fields-template-editor [aria-label="新字段名称"]','独立备注',false)
    await click('.fields-template-editor .add-field button.small','添加字段'); await wait(300)
    const extra = Object.entries((await def()).fields).find(([,f])=>f.title==='独立备注')![0]
    await input('.fields-template-editor [aria-label="字段名称"]','备注')
    check((await def()).fields[extra].title === '备注', '无表格时不能改字段名')
    await click('.fields-template-editor .field-settings button.danger','删除字段');await wait(200)
    check((await def()).fields[extra], '独立编辑删除预演写入数据')
    await click('.fields-template-editor .menu-confirm button','确认删除');await wait(250)
    check(!(await def()).fields[extra], '独立编辑删除未执行');await undo()
    check((await def()).fields[extra], '独立编辑删除不可撤销')
    await click('.fields-editor-field','阶段');await input('.fields-template-editor [aria-label="新选项"]','搁置',false)
    await click('.fields-template-editor button','添加选项');await wait(300)
    check((await def()).fields[phase].options?.includes('搁置'), '无表格时不能管理选项')
    await input('.fields-template-editor [aria-label="模板名称"]','阅读记录',false)
    await click('.fields-template-editor form button','保存名称');await wait(300)
    check((await def()).title === '阅读记录', '模板改名失败')
    await shot('table-independent-template.png')
    const size=win.getSize();win.setSize(1000,760);await wait(250)
    check(await js(`(() => {const r=document.querySelector('.fields-template-editor').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`),'窄窗口模板编辑器溢出')
    await shot('table-template-narrow.png');win.setSize(size[0],size[1]);await wait(200)
    await js(`document.querySelector('[aria-label="关闭模板编辑器"]').click()`)
    await js(`document.querySelector('[aria-label="编辑模板：阅读记录"]').click()`)
    await until(()=>js(`!!document.querySelector('.fields-editor-toolbar')`),'导航编辑入口未打开');await js(`document.querySelector('[aria-label="关闭模板编辑器"]').click()`)
    await js(`document.querySelector('.nav-title button[title="新建模板"]').click()`);await wait(100)
    await click('.nav-menu button','新建模板');await wait(100);await input('.nav-group .name-input','独立新模板')
    await until(()=>js(`document.querySelector('.fields-template-editor [aria-label="模板名称"]')?.value==='独立新模板'`),'新建模板没有直接打开编辑器')
    check(!await js(`!!${pane}.querySelector('.table-scroller')`),'新建模板不应依赖表格')
    const created=(await call('kinds')).find(k=>k.title==='独立新模板')!
    await js(`document.querySelector('[aria-label="关闭模板编辑器"]').click()`)
    await call('run','fields','deleteTemplate',{template:created.template})
  }
  await shot('table-4-table-off.png')
  await togglePlugin('表格')
  check(await js(`!!${pane}.querySelector('.table-row') && !!${pane}.querySelector('.th.add')`), '表格重新启用未恢复')
  await shot('table-5-restored.png')
  let savedViewId=viewId, columnResult: Record<string,unknown> = {}
  await js(`${pane}.querySelector('[aria-label="显示设置"]').click()`);await wait(150)
  check(await js(`!!document.querySelector('[aria-label="表格列模式"]')`), '缺少表格列配置入口')
  {
    const second = await call('run','fields','createTemplate',{title:'资料'}) as {template:string;kind:string}
    const {field:extraField} = await call('run','fields','addField',{template:second.template,title:'序号',type:'number'}) as {field:string}
    await js(`(() => {const e=document.querySelector('[aria-label="表格列模式"]'); e.value='custom';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await wait(200)
    await click('.table-column-section button','清空选择');await wait(100)
    const templateTitle=(await def()).title
    for(const label of [`${templateTitle} · 年度`,'文件 · 格式','资料 · 序号']) {
      await until(()=>js(`!!document.querySelector('.table-column-candidates input[aria-label="${label}"]')`),'缺少可选字段 '+label)
      await js(`document.querySelector('.table-column-candidates input[aria-label="${label}"]').click()`);await wait(100)
    }
    await js(`document.querySelector('.table-column-selected button[aria-label="上移 资料 · 序号"]').click()`);await wait(100)
    // 同一配置里的拖动排序；也保留按钮入口供键盘操作。
    await js(`(() => {const rows=document.querySelectorAll('.table-column-selected li'), grip=rows[1].querySelector('[draggable]');const dt=new DataTransfer();grip.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));})()`);await wait(100)
    await js(`document.querySelector('.table-column-selected li').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}))`);await wait(150)
    check((await data())[year] === '2026' && !(await call('get',[id]))[0].blocks[second.kind], '选择／排序列写入了素材')
    await js(`document.querySelector('.table-column-selected button[aria-label="隐藏 ${templateTitle} · 年度"]').click()`);await wait(100)
    check((await data())[year] === '2026','隐藏列删除了字段值')
    await js(`document.querySelector('.table-column-candidates input[aria-label="${templateTitle} · 年度"]').click()`);await wait(100)
    await shot('table-column-options.png')
    await js(`${pane}.querySelector('[aria-label="显示设置"]').click()`);await wait(150)
    check(await click(`[data-tab-content="${tabId}"] .td button`,'添加模板'),'跨模板空格未提供显式添加')
    await wait(300);check(!!(await call('get',[id]))[0].blocks[second.kind],'显式添加模板失败')
    await cell(1);await input('.cell-inline input','7')
    // 字段名变化保持选列 ID 和顺序；保存选项经原视图编辑入口入库。
    await call('run','fields','renameField',{template,field:year,title:'出版年'});await wait(300)
    const titles=['资料 · 序号','文件 · 格式',`${templateTitle} · 出版年`]
    check(await js(`JSON.stringify([...${pane}.querySelectorAll('.th')].slice(1,4).map(e=>e.textContent.trim()))===${JSON.stringify(JSON.stringify(titles))}`),'选列在改名或排序后错位')
    chooseMenu('另存为新视图…');await js(`${pane}.querySelector('[aria-label="视图操作"]').click()`)
    await until(()=>js(`!!document.querySelector('dialog [aria-label="视图名称"]')`),'保存视图未打开')
    await input('dialog [aria-label="视图名称"]','自选列验证',false)
    await click('dialog button','保存视图');await until(()=>js(`!document.querySelector('dialog')`),'视图未保存')
    await wait(700)
    const workspace=await js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`)
    savedViewId=workspace.tabs.find((t:any)=>t.id===tabId).params.viewId
    const columns=(await call('get',[savedViewId]))[0].blocks.view.data.options
    check(JSON.stringify(columns)===JSON.stringify({columnMode:'custom',columns:[{kind:second.kind,field:extraField},{kind:'file',field:'ext'},{kind,field:year}]}),'保存视图未携带列配置')
    columnResult={columns,columnTitles:titles,extraKind:second.kind,extraField}
    await shot('table-columns-saved.png')
    await togglePlugin('自定义字段')
    check(await js(`${pane}.querySelector('.table-row').textContent.includes('2026') && !${pane}.querySelector('.td.editable')`),'自选列休眠后不只读／丢值')
    await togglePlugin('自定义字段');await togglePlugin('表格');await togglePlugin('表格')
    check(await js(`JSON.stringify([...${pane}.querySelectorAll('.th')].slice(1,4).map(e=>e.textContent.trim()))===${JSON.stringify(JSON.stringify(titles))}`),'启停后自选列未恢复')
  }
  writeFileSync(join(dir, 'table-tools-expected.json'), JSON.stringify({ id, kind, viewId:savedViewId, data: await data(), ...columnResult }))
  await wait(700)
  writeFileSync(join(dir, 'tabletools-result.json'), JSON.stringify({ ok: true }))
  log('表格插件协作通过', { imported: id, template, fields: fields.length, checks: ['新文件导入', '表头贡献', '四类格子编辑', '预演与迁移', '撤销', '字段启停与只读保留', '表格独立启停与检查器编辑'] })
}
