// 公共 UI 契约回归：全新库中的真实封面、表格多选拖动、看板移动与撤销。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
interface Tools {
  js(code: string): Promise<any>
  log(label: string, value: unknown): void
  shot(name: string): Promise<void>
}

export async function uiApiFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const element = (id: string) => `${pane}.querySelector('[data-entity-id="${id}"]')`
  const layout = async (title: string) => {
    await js(`${pane}.querySelector('.display-menu > button').click()`); await wait(100)
    check(await js(`(() => {const b=[...${pane}.querySelectorAll('.display-panel .segmented button')].find(b=>b.textContent===${JSON.stringify(title)});b?.click();return !!b})()`), `没有布局 ${title}`)
    await wait(100)
    await js(`${pane}.querySelector('.display-menu > button').click()`); await wait(650)
  }
  const select = async (ids: string[]) => {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await wait(100)
    for (const [i, id] of ids.entries()) {
      await js(`${element(id)}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,metaKey:${i > 0}}))`)
      await wait(100)
    }
  }
  const drag = async (id: string): Promise<{ ids?: string[]; files?: string[] }> => {
    let files: string[] | undefined
    const listener = (event: Electron.IpcMainEvent, payload: { files: string[] }) => { if (event.sender === win.webContents) files = payload.files }
    ipcMain.on('drag:start', listener)
    try {
      const ids = await js(`(() => {const root=${element(id)};const e=root.matches('.table-row')?root.querySelector('.td.first'):root;
        const dt=new DataTransfer();e.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));
        const raw=dt.getData('application/x-rm-entities');return raw?JSON.parse(raw):null})()`)
      await wait(150)
      return ids ? { ids } : { files }
    } finally { ipcMain.removeListener('drag:start', listener) }
  }

  const paths = ['蓝色', '橙色'].map((name, i) => {
    const path = join(dir, `${name}.svg`)
    writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="${i ? '#e8a560' : '#78a4d4'}"/></svg>`)
    return path
  })
  const files = await call('ingest', paths.map(path => ({ type: 'file' as const, path })))
  const [text] = await call('ingest', [{ type: 'text', text: '公共 UI API 验证：这份文字用来检查混合选择与移动。' }])
  for (let i = 0; i < 30; i++) {
    if ((await call('get', files)).every(v => !!v.blocks.thumb)) break
    await wait(200)
  }
  check((await call('get', files)).every(v => !!v.blocks.thumb), '真实核心进程没有生成封面')
  await layout('表格')
  check(await js(`${pane}.querySelectorAll('.table-row').length===3 && [...${pane}.querySelectorAll('.table-thumb img')].filter(i=>i.complete&&i.naturalWidth>0).length===2`), '表格行或公共封面未显示')
  await select(files)
  const exported = await drag(files[0])
  check(exported.files?.length === 2 && exported.files.every(p => p.endsWith('.svg')), '表格多选未通过宿主交出两份原文件')
  await select([files[0], text])
  const mixed = await drag(files[0])
  check(mixed.ids?.length === 2 && mixed.ids.includes(text) && mixed.ids.includes(files[0]), '表格混合选择丢失身份')
  await shot('ui-api-1-table.png')

  await layout('看板')
  check(await js(`${pane}.querySelectorAll('.card').length===3 && [...${pane}.querySelectorAll('.card img')].filter(i=>i.complete&&i.naturalWidth>0).length===2`), '看板公共卡片或封面未显示')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const drop = async (payload: { ids?: string[]; files?: string[] }, title: string) => {
    const point = await js(`(() => {const col=[...${pane}.querySelectorAll('.kanban-col')].find(c=>c.querySelector('.kanban-title').textContent===${JSON.stringify(title)});
      col.scrollIntoView({block:'nearest',inline:'nearest'});const r=col.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+180)}})()`)
    const data = payload.ids
      ? { items: [{ mimeType: 'application/x-rm-entities', data: JSON.stringify(payload.ids) }], dragOperationsMask: 1 }
      : { items: [], files: payload.files ?? [], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, ...point, data })
    await wait(800)
  }
  try {
    await select([text]); const internal = await drag(text)
    check(internal.ids?.[0] === text, '公共卡片没有提供文字身份')
    await drop(internal, '待处理')
    check((await call('get', [text]))[0].blocks.status?.data.value === '待处理', '文字没有移入看板目标列')
    check(await js(`${element(text)}.closest('.kanban-col').querySelector('.kanban-title').textContent==='待处理'`), '看板订阅没有刷新文字位置')
    await call('undo'); await wait(550)
    check(!(await call('get', [text]))[0].blocks.status && await js(`${element(text)}.closest('.kanban-col').querySelector('.kanban-title').textContent==='未设置'`), '看板撤销后数据或界面未恢复')
    await select([files[0]]); const native = await drag(files[0])
    check(native.files?.length === 1, '公共卡片没有交出文件')
    await drop(native, '进行中')
    check((await call('get', [files[0]]))[0].blocks.status?.data.value === '进行中', '文件回拖看板没有恢复原身份')
    check((await call('query', {})).ids.length === 3, '文件回拖错误地创建了新身份')
    await shot('ui-api-2-kanban.png')
  } finally { dbg.detach() }
  await layout('表格')
  check(await js(`${element(files[0])}.textContent.includes('进行中') && ${pane}.querySelectorAll('.table-row').length===3`), '布局重新挂载后订阅未恢复')
  await shot('ui-api-3-remounted.png')
  log('公共 UI API 回归通过', { checks: ['新图导入与封面', '表格多文件拖出请求', '混合选择完整身份', '看板文字移动与撤销', '文件回拖复用身份', '布局卸载与重新订阅'] })
}
