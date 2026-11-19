// 在独立临时库验证管理记录的生命周期与左侧导航。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function managementFlow(win: BrowserWindow, dir: string, { js, log, shot, chooseMenu }: Tools) {
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const until = async (fn: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 60; i++) { if (await fn()) return; await wait(100) }
    throw new Error(message)
  }
  const click = async (selector: string, title: string) => {
    check(await js(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(title)});b?.click();return !!b})()`), `缺少按钮 ${title}`)
    await wait(250)
  }
  const hasNav = (name: string) => js(`[...document.querySelectorAll('.sidebar .nav-item')].some(e=>e.textContent.trim()===${JSON.stringify(name)})`)
  const toggle = async (title: string) => {
    await js(`document.querySelector('[aria-label="设置视图菜单"]').click()`)
    await until(() => js(`[...document.querySelectorAll('.nav-visibility label')].some(e=>e.textContent.trim()===${JSON.stringify(title)})`), `缺少显示设置 ${title}`)
    await click('.nav-visibility label', title)
    await click('.nav-visibility button', '完成')
  }
  if (process.env.CAPTURE_FLOW === 'managementlegacy') {
    const [template] = (await call('query', { scope: 'trash', role: 'management', has: ['template'] })).ids
    const [oldGroup] = (await call('query', { scope: 'trash', role: 'management', has: ['tagGroups'] })).ids
    const [oldView] = (await call('query', { scope: 'trash', role: 'management', has: ['view'] })).ids
    check(template && oldGroup && oldView, '缺少旧库样本')
    check(!(await call('query', { scope: 'all', has: ['tagGroups'] })).ids.length, '旧空容器没有自动清理')
    await until(() => js(`document.querySelector('.sidebar').textContent.includes('旧版已移除')`), '旧模板没有出现在模板入口')
    await js(`document.querySelector('[title="删除模板与对应字段（可撤销）"]').click()`)
    await until(() => js(`document.querySelector('.management-delete')?.textContent.includes('移除 1 项')`), '旧模板未计算使用数量')
    await click('.management-delete button', '删除模板与字段')
    check(!(await call('get', [template])).length, '旧模板仍残留')
    await call('undo')
    check((await call('get', [template]))[0].deletedAt, '旧模板撤销没有恢复原状态')
    await until(() => js(`!!document.querySelector('[title="删除旧分组记录（保留标签，可撤销）"]')`), '标签入口没有显示旧分组')
    await js(`document.querySelector('.tag-groups details summary').click();document.querySelector('[title="删除旧分组记录（保留标签，可撤销）"]').click()`)
    await until(async () => !(await call('get', [oldGroup])).length, '旧分组记录删除后残留')
    await js(`document.querySelector('[aria-label="设置视图菜单"]').click()`)
    await until(() => js(`!!document.querySelector('.nav-visibility .nav-x')`), '显示设置中没有旧视图入口')
    await js(`document.querySelector('.nav-visibility .nav-x').click()`)
    await until(async () => !(await call('get', [oldView])).length, '旧视图删除后残留')
    await shot('management-legacy.png')
    log('旧管理记录回归通过', { checks: ['空容器自动清理', '旧模板影响预演、一次删除与撤销', '旧分组一次删除', '旧保存视图一次删除'] })
    return
  }
  check(!await hasNav('插件管理数据'), '管理视图没有默认隐藏')
  const source = join(dir, '新导入的资料.txt'); writeFileSync(source, '真实导入的新资料，保留原文件。')
  const point = await js(`(() => {const r=${pane}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+130)}})()`)
  win.webContents.debugger.attach('1.3')
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: [source], dragOperationsMask: 1 } })
  } finally { win.webContents.debugger.detach() }
  await until(async () => (await call('query', { has: ['file'] })).ids.length === 1, '新文件没有导入')
  const [file] = (await call('query', { has: ['file'] })).ids
  await until(async () => (await call('get', [file]))[0]?.blocks.body, 'utilityProcess 没有提取新文件正文')
  const template = await call('create', { template: { title: '研究模板', fields: [{ id: 'fdesc', title: '研究说明', type: 'text' }] } })
  await call('put', file, `tpl:${template}`, { fdesc: '撤销应恢复的字段' })
  await call('put', file, 'tags', { values: ['参考'] })
  await call('run', 'tags', 'createGroup', { title: '用途', tag: '参考' })
  const saved = await call('create', { view: { title: '研究视图', query: { has: ['file'] }, layout: 'masonry' } })
  await wait(400)
  await toggle('插件管理数据')
  await click('.sidebar .nav-item', '插件管理数据')
  await until(() => js(`${pane}.querySelectorAll('.management-row').length===3`), '管理列表缺少记录')
  check(await js(`${pane}.querySelectorAll('.card, textarea, input, [contenteditable="true"], [draggable="true"]').length===0`), '管理视图仍有素材卡片或编辑入口')
  await js(`${pane}.querySelector('[data-record-id="${template}"] summary').click()`)
  await wait(180)
  await shot('management-1-readonly.png')
  check(await js(`!!document.querySelector('.sidebar .nav-item.active') && document.querySelector('.sidebar .nav-item.active').textContent==='插件管理数据'`), '管理视图导航高亮不正确')
  await toggle('研究视图')
  check(!await hasNav('研究视图'), '没有隐藏保存视图')
  check((await call('get', [saved])).length === 1, '隐藏菜单误删了配置')
  win.webContents.reload()
  await until(() => hasNav('插件管理数据'), '重载没有记住导航设置')
  await wait(500)
  check(!await hasNav('研究视图'), '重载没有记住隐藏的保存视图')
  await toggle('研究视图')
  await click('.sidebar .nav-item', '全部')
  await until(() => js(`${pane}.querySelectorAll('.card').length===1`), '管理记录混入素材列表')

  await js(`document.querySelector('[title="删除模板与对应字段（可撤销）"]').click()`)
  await until(() => js(`document.querySelector('.management-delete')?.textContent.includes('移除 1 项')`), '删除确认没有预演影响范围')
  await shot('management-2-delete-template.png')
  await click('.management-delete button', '删除模板与字段')
  check(!(await call('get', [template])).length, '模板删除后仍留有身份')
  check(!(await call('get', [file]))[0].blocks[`tpl:${template}`], '模板字段残留')
  check(!(await call('query', { scope: 'trash' })).ids.length, '删除管理记录进入了回收站')
  win.webContents.send('menu:command', 'undo')
  await until(async () => (await call('get', [file]))[0].blocks[`tpl:${template}`]?.data.fdesc === '撤销应恢复的字段', '菜单撤销没有恢复字段')

  await until(() => js(`!!document.querySelector('[aria-label="管理分组「用途」"]')`), '分组菜单没有显示')
  chooseMenu('删除分组')
  await js(`document.querySelector('[aria-label="管理分组「用途」"]').click()`)
  await until(async () => !(await call('query', { scope: 'all', has: ['tagGroups'] })).ids.length, '删除最后分组仍留有容器')
  check(((await call('get', [file]))[0].blocks.tags.data.values as string[])[0] === '参考', '解散分组删了素材标签')
  await call('undo')
  await until(async () => (await call('query', { scope: 'all', has: ['tagGroups'] })).ids.length, '撤销没有恢复分组')
  chooseMenu('删除视图')
  await js(`(() => {const row=[...document.querySelectorAll('.view-item')].find(e=>e.querySelector('.nav-label')?.textContent.trim()==='研究视图');row?.querySelector('.nav-view-menu').click()})()`)
  await until(async () => !(await call('get', [saved])).length, '保存视图没有一次删除')
  await call('undo')
  check((await call('get', [saved])).length === 1, '视图没有恢复')
  await click('.sidebar .nav-item', '插件管理数据')
  win.setSize(960, 720); await wait(250)
  check(await js(`${pane}.querySelector('.management-tab').scrollWidth <= ${pane}.querySelector('.management-tab').clientWidth + 1`), '窄窗口溢出')
  await shot('management-3-narrow.png')
  check(readFileSync(await call('locateOriginalFile', { id: file, kind: 'file', field: 'path' })).equals(readFileSync(source)), '原文件字节改变')
  log('管理记录回归通过', { file, template, saved, checks: ['真实拖入与正文加工', '管理视图默认隐藏', '只读列表', '导航显隐与重载保留', '模板预演、一次删除及菜单撤销', '最后分组清理且标签保留', '保存视图删除与撤销', '原文件字节', '窄窗口'] })
}
