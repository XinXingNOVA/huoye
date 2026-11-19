import '../../src/main/index'
import { app, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openLibraries, reloadLibrary } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
import { callCore } from '../../src/main/core-client'
import { settingsScript, findSettingsSurface } from './settings-surface'
import { libraryFileUrl } from '../../src/shared/file-location'

const dir = process.env.IMPORT_SETTINGS_TEST,
  phase = process.env.IMPORT_PHASE
async function until(check, label) {
  for (let i = 0; i < 200; i++) {
    const result = await check()
    if (result) return result
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('等待失败 · ' + label)
}

async function run() {
  const lib = await until(() => openLibraries()[0], '临时仓库')
  const win = lib.win,
    js = (code) => win.webContents.executeJavaScript(code)
  const ui = (code) => settingsScript(win, code)
  const call = (method, ...args) => callCore(lib.core, method, ...args)
  const view = async (id) => (await call('get', [id]))[0]
  const ready = () => until(() => js("!!document.querySelector('[aria-label=打开设置]')"), '工作台')
  await ready()
  if (phase === 'first') {
    const manager = localPackages(),
      ref = manager.install(readFileSync(resolve('artifacts/plugins/note.hyplugin')))
    manager.grant(lib.root, ref.hash)
    await call('setExternalPlugin', { ...ref, enabled: true })
    await reloadLibrary(lib)
    await ready()
  }
  const service = (input) => js(`window.bridge.application.service('mcp','settings',${JSON.stringify(input)})`)
  const grant = (await service({})).libraries.find((g) => g.root === lib.root)
  assert(grant, '临时库没有登记')
  const settings = await service({ enabled: true, grant: { key: grant.key, mode: 'organize' } })
  const libraryId = grant.libraryId,
    params = Object.values(JSON.parse(settings.config).mcpServers)[0]
  const client = new Client({ name: 'import-settings-check', version: '1.0.0' }),
    transport = new StdioClientTransport({ ...params, stderr: 'pipe' })
  await client.connect(transport)
  async function mcp(name, args = {}) {
    const result = await client.callTool({ name, arguments: { libraryId, ...args } })
    assert(!result.isError, JSON.stringify(result.content))
    return result.structuredContent
  }
  const click = (script, selector, label) =>
    until(
      () =>
        script(
          `(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.checkVisibility());if(!b||b.disabled)return false;b.click();return true})()`,
        ),
      label,
    )
  try {
    if (phase === 'resume') {
      const { space, nextId, request, saved, noteId } = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
      assert.equal((await mcp('get_import_settings')).collect, false)
      const restartId = await until(
        async () =>
          (await mcp('list_space_files', { spaceId: space.id })).items.find((f) => f.name === '关闭期间新增.md')
            ?.collected,
        '启动没有检查新增',
      )
      await until(async () => !!(await view(restartId)).blocks.body, '重启收录未加工')
      assert((await view(nextId)).deletedAt)
      assert.deepEqual(await mcp('import_to_library', request), saved)
      assert.equal((await view(noteId)).blocks.note.data.text, '延迟附加笔记')

      return
    }
    assert((await client.listTools()).tools.some((t) => t.name === 'import_to_library'))
    const space = await js(`window.bridge.spaces.create(${JSON.stringify(dir)},'导入配置共享空间','shared')`)
    await call('linkFileSpace', space.root)
    const old = join(dir, '已有候选.md')
    writeFileSync(old, '# 存量不要自动收录')
    await js(`window.bridge.spaces.add(${JSON.stringify(space.root)},${JSON.stringify([old])})`)
    const initial = await mcp('list_space_files', { spaceId: space.id })
    assert.equal(initial.total, 1)

    await js("document.querySelector('[aria-label=打开设置]').click()")
    await until(() => findSettingsSurface(win), '设置窗口')
    await click(ui, '.settings-library-nav button', '导入与空间')
    const select = (selector, value) =>
      until(
        () =>
          ui(
            `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
          ),
        '选择规则',
      )
    await select('#import-default-space', space.id)
    await until(async () => (await mcp('get_import_settings')).defaultSpaceId === space.id, '默认空间落盘')
    await select('#import-default-collect', 'false')
    await until(async () => (await mcp('get_import_settings')).collect === false, '保存方式落盘')
    await ui(
      `[...document.querySelectorAll('.import-space-rule')].find(row=>row.textContent.includes('导入配置共享空间')).querySelector('select').id='test-space-rule'`,
    )
    await select('#test-space-rule', 'true')
    await until(
      async () => (await mcp('get_import_settings')).spaces.find((r) => r.spaceId === space.id)?.automatic,
      '新增规则落盘',
    )
    const panel = findSettingsSurface(win)
    writeFileSync(join(dir, '01-import-settings-wide.png'), (await panel.webContents.capturePage()).toPNG())
    panel.setSize(720, 600)
    await until(() => ui('window.innerWidth<=720'), '窄窗口')
    assert(await ui("(()=>{const e=document.querySelector('.import-settings');return e.scrollWidth<=e.clientWidth})()"))
    writeFileSync(join(dir, '02-import-settings-narrow.png'), (await panel.webContents.capturePage()).toPNG())
    await click(ui, '.import-settings button', '打开文件空间工作台 →')
    await until(() => js("document.querySelector('.file-spaces-tab')?.checkVisibility()"), '工作台')
    await click(js, '.space-header-top button', '单次导入…')
    const image = join(dir, '单次导入新图片.png')
    await sharp({ create: { width: 310, height: 210, channels: 3, background: '#49a0bf' } })
      .png()
      .toFile(image)
    assert.deepEqual(await js("[...document.querySelectorAll('.space-import-once select')].map(s=>s.value)"), [
      space.id,
      'false',
    ])
    // 在测试端丢弃第一次成功回执，核对 UI 再次发送的参数和仓库中的实际结果。
    await js(`(()=>{const post=MessagePort.prototype.postMessage;window.importRequests=[];MessagePort.prototype.postMessage=function(msg,...rest){
    if(msg?.method==='importToLibrary') {
      window.importRequests.push(msg.args)
      if(window.importRequests.length===1){const original=this.onmessage;this.onmessage=function(event){
        if(event.data.id===msg.id && 'result' in event.data){this.onmessage=original;return original.call(this,new MessageEvent('message',{data:{id:msg.id,error:'测试：首次回执丢失'}}))}
        return original.call(this,event)
      }} else MessagePort.prototype.postMessage=post
    }
    return post.call(this,msg,...rest)
  }})()`)
    const pick = dialog.showOpenDialog
    try {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] })
      await click(js, '.space-import-once button', '选择文件并导入…')
      await until(
        () => js("document.querySelector('.file-spaces-tab [role=alert]')?.textContent.includes('首次回执丢失')"),
        '重试提示',
      )
    } finally {
      dialog.showOpenDialog = pick
    }
    await click(js, '.space-import-once button', '重试本次导入')
    await until(() => js("!document.querySelector('.space-import-once')"), '重试完成')
    const requests = await js('window.importRequests')
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1], requests[0])
    await until(
      () => js("document.querySelector('.space-pill.active')?.textContent.includes('未收录')"),
      '落到目标空间未收录列表',
    )
    await until(
      () => js("document.querySelector('.space-file-list')?.innerText.includes('单次导入新图片.png')"),
      '文件可见',
    )
    let p = await mcp('list_space_files', { spaceId: space.id })
    assert.equal(p.total, 2)
    const picture = p.items.find((f) => f.name === '单次导入新图片.png')
    assert(picture && !picture.collected)
    await js(
      "(()=>{const e=document.querySelector('.space-search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'单次导入新图片');e.dispatchEvent(new Event('input',{bubbles:true}))})()",
    )
    await until(
      () =>
        js(
          "document.querySelectorAll('.space-file').length===1 && document.querySelector('.space-file').textContent.includes('单次导入新图片')",
        ),
      '文件名筛选',
    )
    await js("document.querySelector('.space-file input').click()")
    await until(() => js("document.querySelector('.space-adoption button')?.textContent.includes('(1)')"), '所选文件可收录')
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    writeFileSync(join(dir, '03-space-collect.png'), (await win.webContents.capturePage()).toPNG())
    await click(js, '.space-adoption button', '收录所选 (1)')
    const pictureId = await until(
      async () =>
        (await mcp('list_space_files', { spaceId: space.id })).items.find((f) => f.id === picture.id).collected,
      '图片未收录',
    )
    await until(async () => !!(await view(pictureId)).blocks.thumb, '真实 utilityProcess 图片加工未完成')
    const ref = (await view(pictureId)).blocks.file.data.path
    assert.equal(
      await js(
        `new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth);image.onerror=()=>resolve(0);image.src=${JSON.stringify(libraryFileUrl(lib.id, ref))}})`,
      ),
      310,
    )
    await js("document.querySelector('.space-tabs [aria-label=记录管理]').click()")
    await click(js, 'button', '组合删除记录…')
    await click(js, '.item-disposal-dialog button', '取消')
    await js("document.querySelector('.space-tabs [aria-label=文件]').click()")
    // 普通拖入也遵循默认策略；稍后的后台扫描仍保留手动收录的选择。
    const spaceTab = await js("document.querySelector('.tab.active').dataset.tab")
    await js("document.querySelector('[aria-label=全部视图]').click()")
    await until(() => js("document.querySelector('.tab.active')?.textContent.includes('全部')"), '素材视图')
    const dragBytes = (
      await sharp({ create: { width: 40, height: 32, channels: 3, background: '#aa8811' } })
        .png()
        .toBuffer()
    ).toString('base64')
    await js(
      `(()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(dragBytes)}),c=>c.charCodeAt(0))],'拖入样本.png',{type:'image/png'}));document.querySelector('.tab-pane:not(.hidden)').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}))})()`,
    )
    const dropped = await until(
      async () => (await mcp('list_space_files', { spaceId: space.id })).items.find((f) => f.name === '拖入样本.png'),
      '默认拖入',
    )
    assert(!dropped.collected)
    await js(`document.querySelector(${JSON.stringify('[data-tab="' + spaceTab + '"]')}).focus()`)
    await until(() => js("document.querySelector('.file-spaces-tab')?.checkVisibility()"), '返回文件空间')
    const next = join(dir, '空间后来新增.md')
    writeFileSync(next, '# 来自空间\n\n自动收录后加工正文')
    await js(`window.bridge.spaces.add(${JSON.stringify(space.root)},${JSON.stringify([next])})`)
    await js(`[...document.querySelectorAll('.space-list button')].find(e=>e.textContent==='刷新').click()`)
    const nextId = await until(
      async () =>
        (await mcp('list_space_files', { spaceId: space.id })).items.find((f) => f.name === '空间后来新增.md')
          ?.collected,
      '刷新未自动收录',
    )
    await until(async () => !!(await view(nextId)).blocks.body, '新增文档未加工')
    assert(
      !(await mcp('list_space_files', { spaceId: space.id })).items.find((f) => f.id === initial.items[0].id).collected,
    )
    assert(!(await mcp('list_space_files', { spaceId: space.id })).items.find((f) => f.id === dropped.id).collected)
    await call('undo')
    assert((await view(nextId)).deletedAt)
    await call('scanSpaceImports')
    assert((await view(nextId)).deletedAt)
    const mcpPath = join(dir, 'MCP待收录.md')
    writeFileSync(mcpPath, '# MCP new content')
    const request = {
      requestId: 'mcp-config-save',
      files: [{ path: mcpPath, metadata: { 'note.initial': { text: '延迟附加笔记' } } }],
    }
    const saved = await mcp('import_to_library', request)
    assert.equal(saved.items.length, 0)
    assert.equal(saved.saved.length, 1)
    assert.deepEqual(await mcp('import_to_library', request), saved)
    p = await mcp('list_space_files', { spaceId: space.id })
    const candidate = p.items.find((f) => f.id === saved.saved[0].fileId)
    const adopted = await mcp('adopt_space_files', {
      spaceId: space.id,
      requestId: 'mcp-manual-collect',
      files: [{ id: candidate.id, revision: candidate.revision }],
    })
    const noteId = adopted.result.items[0].id
    assert.equal((await view(noteId)).blocks.note.data.text, '延迟附加笔记')
    const overridePath = join(dir, '本次覆盖.md')
    writeFileSync(overridePath, '# Override')
    const override = await mcp('import_to_library', {
      requestId: 'mcp-override-collect',
      files: [{ path: overridePath }],
      collect: true,
    })
    assert.equal(override.items.length, 1)
    assert.equal((await mcp('get_import_settings')).collect, false)
    await js(
      `window.bridge.application.service('mcp','settings',${JSON.stringify({ grant: { key: grant.key, mode: 'read' } })})`,
    )
    assert(
      (
        await client.callTool({
          name: 'import_to_library',
          arguments: { libraryId, requestId: 'denied-mcp-import', files: [{ path: overridePath }] },
        })
      ).isError,
    )
    await js(
      `window.bridge.application.service('mcp','settings',${JSON.stringify({ grant: { key: grant.key, mode: 'organize' } })})`,
    )
    const offline = join(dir, '关闭期间新增.md')
    writeFileSync(offline, '# restart auto')
    await js(`window.bridge.spaces.add(${JSON.stringify(space.root)},${JSON.stringify([offline])})`)

    writeFileSync(join(dir, 'state.json'), JSON.stringify({ space, nextId, request, saved, noteId }))
  } finally {
    await client.close()
    await transport.close()
  }
}
app
  .whenReady()
  .then(run)
  .then(
    () => {
      writeFileSync(join(dir, phase + '-result.json'), JSON.stringify({ ok: true }))
      app.exit(0)
    },
    (error) => {
      console.error(error)
      app.exit(1)
    },
  )
