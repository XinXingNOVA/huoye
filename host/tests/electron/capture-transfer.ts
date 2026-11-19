// 独立临时库：系统剪贴板 + DOM 传输 + CDP 本地文件拖入，实际触发 utilityProcess 加工。
import { clipboard, ClipboardItem, type BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
export async function transferFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools): Promise<void> {
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const until = async (test: () => Promise<unknown>, message: string) => {
    for (let n = 0; n < 100; n++) { if (await test()) return; await wait(100) }
    throw new Error(message)
  }
  const ids = async () => (await call('query', { scope: 'content' })).ids
  const views = async () => call('get', await ids())
  check((await ids()).length === 0, '传输验证需要全新临时库')
  const png = await sharp({ create: { width: 43, height: 27, channels: 3, background: '#357ab8' } }).png().toBuffer()
  const downloaded = await sharp({ create: { width: 61, height: 37, channels: 3, background: '#da7531' } }).png().toBuffer()
  let requests = 0
  let holdImage = false, releaseImage: (() => void) | undefined
  const server = createServer((req, res) => {
    requests++
    if (req.url === '/redirect.png') { res.writeHead(302, { Location: '/image' }); res.end(); return }
    if (req.url === '/bad.png') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login needed</html>'); return }
    const send = () => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(downloaded) }
    if (holdImage) releaseImage = send; else send()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试图片服务未启动')
  const base = `http://127.0.0.1:${address.port}`
  // 全部物化后再覆盖；只暂存还原，不解析或打印用户原有内容。
  const saved: ClipboardItem[] = []
  for (const item of await clipboard.read()) {
    const data: Record<string, Blob | Electron.ClipboardBookmark> = {}
    for (const type of item.types) data[type] = await item.getType(type)
    saved.push(new ClipboardItem(data))
  }
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const paste = async (setup: string, target = 'window', drop = false) => js(`(() => {
    const dt=new DataTransfer();${setup}
    const e=${drop ? "new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})" : "new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})"};
    ${target}.dispatchEvent(e);return e.defaultPrevented;
  })()`)
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
      'text/html': `<img src="${base}/unneeded.png">`, 'text/plain': `${base}/unneeded.png` })])
    await js('document.activeElement?.blur()')
    win.webContents.paste()
    await until(async () => (await views()).some(v => v.blocks.image?.data.width === 43 && v.blocks.thumb), '系统粘贴图片未完成实际加工')
    check((await ids()).length === 1, '系统图片粘贴重复生成素材')
    check(requests === 0, '已有图片数据仍下载 HTML 地址')
    const first = (await ids())[0]
    check((await call('get', [first]))[0].blocks.source?.data.url === `${base}/unneeded.png`, '无网页来源时没有保留附带的图片地址')
    win.webContents.paste(); await wait(700)
    check((await ids()).length === 1, '重复粘贴未去重')
    await call('undo'); check((await ids()).length === 0, '图片收录不能撤销')
    win.webContents.paste()
    await until(async () => (await ids()).includes(first), '再次粘贴未恢复原身份')
    await shot('transfer-1-native-image.png')
    log('原生剪贴板图片', { deduplicated: true, restored: true, requests })

    // HTML 图片、网络重定向，保留原字节及来源。
    await call('put', first, 'tags', { values: ['接收目标检查'] })
    await until(() => js(`[...document.querySelectorAll('.sidebar .nav-label')].some(e=>e.textContent==='接收目标检查')`), '未生成标签筛选')
    holdImage = true
    await paste(`dt.setData('text/html', ${JSON.stringify(`<img src="${base}/redirect.png">`)});`, 'window', true)
    await until(async () => !!releaseImage, '下载没有到达图片服务')
    await js(`[...document.querySelectorAll('.sidebar .nav-label')].find(e=>e.textContent==='接收目标检查').closest('.nav-item').click()`)
    await wait(150)
    holdImage = false; releaseImage!()
    await until(async () => (await views()).some(v => v.blocks.image?.data.width === 61 && v.blocks.thumb), '拖入 HTML 图片未下载加工')
    const remote = (await views()).find(v => v.blocks.image?.data.width === 61)!
    const remoteTags = remote.blocks.tags?.data.values
    check(!Array.isArray(remoteTags) || !remoteTags.includes('接收目标检查'), '下载期间切换筛选导致素材被写入错误标签')
    check(readFileSync(join(lib().root, String(remote.blocks.file.data.path))).equals(downloaded), '下载图片被重新编码')
    check(remote.blocks.source?.data.url === `${base}/redirect.png`, '图片来源丢失')
    const requestCount = requests
    await js(`[...document.querySelectorAll('.sidebar .nav-label')].find(e=>e.textContent==='全部').closest('.nav-item').click()`)
    await wait(150)
    const embedded = await sharp({ create: { width: 17, height: 11, channels: 3, background: '#34ad77' } }).png().toBuffer()
    await paste(`dt.setData('text/html',${JSON.stringify(`<img src="data:image/png;base64,${embedded.toString('base64')}">`)});`, 'window', true)
    await until(async () => (await views()).some(v => v.blocks.image?.data.width === 17 && v.blocks.thumb), '内嵌图片未完成收录加工')

    // 图文带有同图 File 时仍保留正文；无 text/plain 的 HTML 也能收录。
    await paste(`dt.items.add(new File([Uint8Array.from(${JSON.stringify([...png])})],'image.png',{type:'image/png'}));dt.setData('text/html',${JSON.stringify(`<h2>图文摘录验证</h2><p>保留<strong>正文</strong></p><img src="${base}/image">`)});`)
    await until(async () => (await views()).some(v => String(v.blocks.text?.data.content).includes('图文摘录验证')), '图文正文丢失')
    const rich = (await views()).find(v => String(v.blocks.text?.data.content).includes('图文摘录验证'))!
    check(String(rich.blocks.text.data.content).includes('**正文**') && String(rich.blocks.text.data.content).includes(`${base}/image`), '图文结构或图片引用丢失')
    check(requests === requestCount, '整段图文意外下载配图')
    await paste(`dt.setData('text/uri-list',${JSON.stringify('# comment\r\nhttps://example.com/article\r\nhttps://example.org/')});`, 'window', true)
    await until(async () => (await views()).some(v => String(v.blocks.text?.data.content).includes('https://example.org/')), '网址列表未保存')
    await paste(`dt.setData('text/plain',${JSON.stringify('普通文字\n第二行')});`)
    await until(async () => (await views()).some(v => v.blocks.text?.data.content === '普通文字\n第二行'), '纯文本未保存')
    await paste(`dt.setData('text/plain',${JSON.stringify(`${base}/bad.png`)});`)
    await until(async () => (await views()).some(v => v.blocks.text?.data.content === `${base}/bad.png`), '下载失败没有保留链接')
    await until(() => js(`document.querySelector('.toast')?.textContent.includes('未下载')`), '下载失败没有明确提示')

    // 编辑器和已经接管事件的插件不被全局入口抢走。
    const before = (await ids()).length
    await js(`const editable=document.createElement('div');editable.id='transfer-editable';editable.contentEditable='true';document.body.append(editable)`)
    check(!await paste(`dt.setData('text/plain','不应该成为素材');`, `document.getElementById('transfer-editable')`), '抢走 contenteditable 粘贴')
    await js(`document.getElementById('transfer-editable').remove();const owned=document.createElement('div');owned.id='transfer-owned';owned.addEventListener('paste',e=>e.preventDefault());document.body.append(owned)`)
    await paste(`dt.setData('text/plain','插件已处理');`, `document.getElementById('transfer-owned')`)
    await js(`document.getElementById('transfer-owned').remove()`)
    await wait(300); check((await ids()).length === before, '编辑操作重复进入仓库')

    // 本地目录真实拖入，随后回拖库内文件/内部身份不产生副本。
    const folder = join(dir, 'drop-folder'); mkdirSync(folder)
    writeFileSync(join(folder, '本地.txt'), '真实文件拖入验证')
    const drag = (type: string, files: string[]) => win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, x: 600, y: 250, data: { items: [], files, dragOperationsMask: 1 } })
    await drag('dragEnter', [folder]); await drag('dragOver', [folder]); await drag('drop', [folder])
    await until(async () => (await views()).some(v => v.blocks.body?.data.content === '真实文件拖入验证'), '本地目录拖入失效')
    const count = (await ids()).length, path = join(lib().root, String(remote.blocks.file.data.path))
    await drag('dragEnter', [path]); await drag('dragOver', [path]); await drag('drop', [path])
    await paste(`dt.setData('application/x-rm-entities',${JSON.stringify(JSON.stringify([first]))});`, 'window', true)
    await wait(500); check((await ids()).length === count, '已有素材回拖重复导入')
    await shot('transfer-2-all-inputs.png')
    log('传输验证通过', { materials: count, networkRequests: requests, nativeClipboard: true, localDirectory: true, editableIsolation: true })
  } finally {
    if (saved.length) await clipboard.write(saved); else clipboard.clear()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
