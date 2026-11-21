import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { captureMcpSettings } from './capture-settings'
import { openLibraryMcpSettings } from './settings-surface'
import { until } from './theme-settings'

export async function sourceMcpFlow(win: BrowserWindow, dir: string) {
  const { space, note, ref } = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const lib = libraryOf(win.webContents)!, libraryId = lib.id
  const settings = await captureMcpSettings(win, 'read')
  const local = (method: string, input?: object) => win.webContents.executeJavaScript(
    'window.bridge.application.service("mcp",' + JSON.stringify(method) + ',' + JSON.stringify(input ?? {}) + ')')
  const client = new Client({ name: 'source-workflow', version: '1' })
  const parameters = Object.values(JSON.parse(settings.config).mcpServers)[0] as StdioServerParameters
  await client.connect(new StdioClientTransport(parameters))
  const call = async (name: string, input: object, library = libraryId) => {
    const result = await client.callTool({ name, arguments: { ...(!['create_library', 'list_allowed_file_spaces'].includes(name) && { libraryId: library }), ...input } })
    if (result.isError) throw Error(JSON.stringify(result.content))
    return result.structuredContent as any
  }
  const scan = async (id: string) => {
    const options = { spaceId: id, requestId: randomUUID() }
    let status = await call('check_file_space', { ...options, action: 'start' })
    await until(async () => {
      status = await call('check_file_space', { ...options, action: 'status' })
      return status.state !== 'running'
    }, '核对未结束')
    assert.equal(status.state, 'completed', JSON.stringify(status))
    return options
  }
  const list = { spaceId: space.id, sourceKind: 'directory' }
  const files = (options: object = {}, libId = libraryId) => call('list_space_files', { ...list, ...options }, libId)
  const inventory = (group: string, extra: object = {}, libId = libraryId) => call('list_space_items', { spaceId: space.id, group, ...extra }, libId)
  const setGrant = async (id: string, mode: string, browse = false) => {
    const row = (await local('settings')).libraries.find((l: any) => l.libraryId === id)
    await local('settings', { grant: { key: row.key, mode, fileSpaces: [{ spaceId: space.id, browseDirectory: browse, revise: false, recycle: false }] } })
  }
  const adopt = async (choices: any[], id = libraryId, requestId = randomUUID()) => call('adopt_space_files', {
    ...list, requestId, files: choices.map(({ id, stamp }) => ({ id, stamp }))
  }, id)
  try {
    const names = (await client.listTools()).tools.map(t => t.name)
    assert(names.includes('check_file_space') && names.includes('list_space_items'))
    const sources = await call('list_file_spaces', { includeDirectories: true })
    assert.equal(sources.spaces.find((s: any) => s.id === space.id).browseDirectory, false)
    const primary = sources.spaces.find((s: any) => s.default)
    assert.equal(primary.sourceKind, 'managed')
    assert(!(await call('list_file_spaces', {})).spaces.some((s: any) => s.id === space.id))
    await assert.rejects(files(), /DIRECTORY_BROWSE_DENIED/)
    await assert.rejects(files({ spaceId: randomUUID(), collectFilter: 'collected' }), /SPACE_NOT_LINKED/)
    assert.equal((await files({ collectFilter: 'collected' })).items.length, 0)
    await assert.rejects(call('check_file_space', { spaceId: space.id, action: 'start', requestId: randomUUID() }), /READ_ONLY/)
    assert.equal((await inventory('attachment')).items[0].id, note)
    assert((await inventory('primary', { missingOnly: true })).missingIssue)
    const prefs = await openLibraryMcpSettings(win)
    const ui = (code: string) => prefs.webContents.executeJavaScript(code)
    await until(() => ui(`(() => { const b=document.querySelector('.mcp-grant.is-current button[aria-expanded]'); if(!b)return false; if(b.getAttribute('aria-expanded')!=='true')b.click(); return true })()`), '本库细项授权未出现')
    await until(() => ui(`(() => { const l=[...document.querySelectorAll('.mcp-grant.is-current label')].find(e=>e.textContent.includes('浏览此原地目录')); const c=l?.querySelector('input'); if(!c || c.disabled)return false; if(!c.checked)c.click(); return true })()`), '原地浏览许可未出现')
    await until(async () => (await local('settings')).libraries.find((l:any) => l.libraryId===libraryId)?.fileSpaces.some((s:any)=>s.browseDirectory), '浏览许可未保存')
    await setGrant(libraryId,'admin',true)
    const sub = join(space.root,'子目录'); mkdirSync(sub)
    await sharp({create:{width:32,height:32,channels:3,background:'#8c97ad'}}).png().toFile(join(sub,'新图.png'))
    const checked = await scan(space.id)
    const folders = await files({folderId:null})
    const folder = folders.items.find((i:any)=>i.folder)
    assert.equal((await files({folderId:folder.id})).items[0].name,'新图.png')
    const firstPage = await files({limit:1})
    assert(firstPage.nextAfterId)
    assert.notEqual((await files({afterId:firstPage.nextAfterId})).items[0].id,firstPage.items[0].id)
    const [doc] = (await files({suffixes:['md'], collectFilter:'uncollected'})).items
    const [pic] = (await files({suffixes:['png']})).items
    const original = join(space.root,doc.name), away = join(dir,'暂时移走.md')
    writeFileSync(original,'外部修订')
    await assert.rejects(adopt([pic,doc]))
    assert.equal((await inventory('primary')).counts.primary,0)
    await scan(space.id)
    const [fresh] = (await files({suffixes:['md']})).items
    const requestId = randomUUID(), receipt = await adopt([pic,fresh],libraryId,requestId)
    const [picture,item] = receipt.result.items.map((v:any)=>v.id)
    assert.equal((await adopt([pic,fresh],libraryId,requestId)).replayed,true)
    await until(async () => (await call('read_preview',{ids:[picture]})).items[0].state==='ready','收录的新 PNG 没有生成预览')
    await local('settings',{creation:{parent:dir,mode:'admin'}})
    const second = await call('create_library',{name:'第二个库', requestId:randomUUID()})
    const secondId=second.libraryId
    assert(secondId)
    await local('management',{action:'allow-space',sourceKind:'directory',root:space.root})
    assert((await call('list_allowed_file_spaces',{})).spaces.some((s:any)=>s.id===space.id && s.sourceKind==='directory'))
    await call('link_library_file_space',{spaceId:space.id},secondId)
    await assert.rejects(files({},secondId),/DIRECTORY_BROWSE_DENIED/)
    await assert.rejects(call('check_file_space',{...checked,action:'cancel'},secondId),/CHECK_NOT_FOUND/)
    await setGrant(secondId,'organize',true)
    const peer = (await adopt([fresh],secondId)).result.items[0].id
    writeFileSync(original,'新版只接纳进第一个库')
    await scan(space.id); await setGrant(libraryId,'organize',false)
    assert.equal((await files({collectFilter:'outdated'})).items[0].collected,item)
    const update=await call('preview_file_update',{id:item})
    await call('accept_file_update',{id:item,expectedPath:update.expectedPath,contentVersion:update.current.id,revision:update.revision,requestId:randomUUID()})
    assert.equal((await files({collectFilter:'outdated'})).items.length,0)
    assert.equal((await files({collectFilter:'outdated'},secondId)).items[0].collected,peer)
    renameSync(original,away); await scan(space.id)
    const missing=await inventory('primary',{missingOnly:true})
    assert.deepEqual(missing.batchIds,[item])
    const selected={action:'trash',primarySpaceId:space.id,missingOnly:true,ids:missing.batchIds}
    const plan=await call('preview_item_lifecycle',selected)
    renameSync(away,original)
    await assert.rejects(call('apply_item_lifecycle',{...selected,previewToken:plan.previewToken,requestId:randomUUID()}),/PREVIEW_CHANGED/)
    renameSync(original,away); await scan(space.id)
    const trash=async (choice: object) => {
      const p=await call('preview_item_lifecycle',choice)
      await call('apply_item_lifecycle',{...choice,previewToken:p.previewToken,requestId:randomUUID()})
    }
    await trash(selected)
    assert.equal((await inventory('trashed')).items[0].id,item)
    assert.equal((await inventory('primary',{},secondId)).items[0].id,peer)
    assert.equal((await inventory('attachment')).items[0].id,note)
    await trash({action:'restore',primarySpaceId:space.id,ids:[item]})
    assert.equal((await inventory('primary')).counts.primary,2)
    assert.equal(readFileSync(away,'utf8'),'新版只接纳进第一个库')
    const imported=await call('import_to_library',{files:[{path:away}],requestId:randomUUID()})
    const managedId=imported.items[0].id
    const info=await callCore(lib.core,'fileStorageInfo',managedId)
    renameSync(info.path!,join(dir,'移出的托管原件.md'))
    await scan(primary.id)
    assert.deepEqual((await call('list_space_items',{group:'primary',spaceId:primary.id,missingOnly:true})).batchIds,[managedId])
    assert.deepEqual((await callCore(lib.core,'get',[note]))[0].blocks['sample-attachment'].data.files,[ref])
    const counts = (await inventory('primary')).counts
    await win.webContents.executeJavaScript('window.bridge.spaces.directories.unlink(' + JSON.stringify(space.id) + ',' +
      JSON.stringify({active:counts.primary+counts.attachment+counts.unclassified,trashed:counts.trashed}) + ')')
    assert.equal((await call('list_file_spaces',{includeDirectories:true})).spaces.find((s:any)=>s.id===space.id).state,'detached')
    assert.equal((await inventory('primary')).counts.primary,2)
    await assert.rejects(files({collectFilter:'collected'}))
    await assert.rejects(call('check_file_space',{action:'start',spaceId:space.id,requestId:randomUUID()}),/SPACE_NOT_LINKED/)
    assert.equal((await inventory('primary',{},secondId)).items[0].id,peer)
    writeFileSync(join(dir,'source-mcp-result.json'),JSON.stringify({ok:true,tools:names.length,libraries:2}))
  } finally { await client.close() }
}
