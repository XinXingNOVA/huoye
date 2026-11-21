import assert from 'node:assert/strict'
import { copyFileSync, rmSync, utimesSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import { allClosed, libraryOf, openLibrary, type OpenLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { DirectoryPage, DirectorySpace } from '../../src/shared/directory-spaces'
import { until } from './theme-settings'

/** 在系统选择器边界交付只读样本目录，余下走生产 UI、IPC 和实际图片解码。 */
export async function directorySpaceFlow(win: BrowserWindow, dir: string) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const click = (label: string) => until(() => js(`(() => {
    const el = [...document.querySelectorAll('button,.nav-item')].find(e => e.checkVisibility() &&
      (e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)}))
    if (!el || el.disabled) return false
    el.click(); return true
  })()`), '无法点击 ' + label)
  const manage = () => js("document.querySelector('.directory-management:not([open]) summary')?.click()")
  const spaceList = (): Promise<DirectorySpace[]> => js('window.bridge.spaces.directories.list()')
  const source = join(dir, '只读工程'), folder = join(source, '原画'), file = join(folder, '封面.png')
  const lib = libraryOf(win.webContents)!
  const files = async () => (await callCore(lib.core, 'query', { has: ['file'] })).ids
  const initial = await files()
  await click('文件空间')
  if (process.env.CAPTURE_FLOW === 'directorycollection' || process.env.CAPTURE_FLOW === 'directorycollectionresume') {
    const moved = join(dir, '移位的工程'), stateFile = join(dir, 'directorycollection-result.json')
    async function readImage(id: string, width = 120) {
      const view = (await callCore(lib.core, 'get', [id]))[0]
      assert.ok(view.blocks.thumb)
      const url = 'lib://' + lib.id + '/' + String(view.blocks.file.data.path).split('/').map(encodeURIComponent).join('/')
      await until(() => js(`(async()=>{ const img=new Image(); img.src=${JSON.stringify(url)}; await img.decode(); return img.naturalWidth===${width} })()`), '仓库原件未解码')
    }
    if (process.env.CAPTURE_FLOW === 'directorycollectionresume') {
      const { id, spaceId } = JSON.parse(readFileSync(stateFile, 'utf8'))
      assert.equal((await spaceList())[0].id, spaceId)
      await readImage(id, 170)
      assert.deepEqual(await files(), [id])
      writeFileSync(join(dir, 'directorycollectionresume-result.json'), JSON.stringify({ ok: true }))
      return
    }
    mkdirSync(folder, { recursive: true }); mkdirSync(join(source, 'node_modules'))
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#548090' } }).png().toFile(file)
    copyFileSync(file, join(source, 'node_modules', 'noise.png'))
    writeFileSync(join(source, '说明.md'), '不在本次收录范围')
    const picker = dialog.showOpenDialog, confirm = dialog.showMessageBox
    let selected = source, other: OpenLibrary | undefined
    try {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof picker
      await click('关联或新建空间…'); await click('关联原地目录…')
      await click('预览收录')
      await until(() => js("document.querySelector('section[aria-label=按文件类型收录]')?.textContent.includes('匹配 1 个 · 已在本库 0 个 · 待收录 1 个')"), '图片预览计数有误')
      assert.deepEqual(await files(), initial)
      await click('收录 1 个文件')
      await until(() => js("document.querySelector('section[aria-label=按文件类型收录]')?.textContent.includes('已收录 1 个文件')"), '原地收录未成功')
      const [id] = (await files()).filter((id: string) => !initial.includes(id))
      await until(async () => !!(await callCore(lib.core, 'get', [id]))[0]?.blocks.thumb, '新原地 PNG 未完成真实加工')
      await readImage(id)
      await click('预览收录')
      await until(() => js("document.querySelector('section[aria-label=按文件类型收录]')?.textContent.includes('待收录 0 个')"), '再预览重复收录')
      const managed = (await callCore(lib.core, 'listFileSpaces')).find(s => s.default)!
      assert.equal((await callCore(lib.core, 'listSpaceFiles', { spaceId: managed.id })).total, 0)
      other = await openLibrary(join(dir, '第二个库.library'), { show: false })
      const secondLink: DirectorySpace = await other.win.webContents.executeJavaScript('window.bridge.spaces.directories.pick()')
      assert.equal(secondLink.id, (await spaceList())[0].id)
      const independent = await callCore(other.core, 'previewDirectoryCollection', secondLink.id, ['png'])
      assert.equal(independent.pending, 1)
      const accepted = await callCore(other.core, 'collectDirectoryFiles', secondLink.id, ['png'], independent.token)
      assert.equal(accepted.created, 1)
      const [secondId] = (await callCore(other.core, 'query', { has: ['file'] })).ids
      assert.notEqual(id, secondId)
      renameSync(source, moved); selected = moved
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof confirm
      await manage(); await click('重新定位根目录…')
      await until(async () => (await spaceList())[0]?.root === moved, '根目录未接续')
      await readImage(id)
      const info = await callCore(lib.core, 'fileStorageInfo', id)
      assert.equal(info.path, join(moved, '原画', '封面.png'))
      assert.equal((await callCore(other.core, 'fileStorageInfo', secondId)).path, info.path)
      const previous = (await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path
      await manage(); await click('解除目录关联')
      await until(() => js("document.querySelector('[aria-label=解除目录关联预览]')?.textContent.includes('1 项在用素材、0 项回收站素材')"), '缺少本库引用预览')
      await click('取消'); await readImage(id)
      await click('解除目录关联'); await click('确认解除关联')
      await until(() => js("document.querySelector('[aria-label=原地来源关联]')?.textContent.includes('已解除关联')"), '已解除来源没有保留')
      assert.equal((await callCore(lib.core, 'fileStorageInfo', id)).associationState, 'detached')
      assert.equal((await callCore(other.core, 'fileStorageInfo', secondId)).state, 'available')
      await sharp({ create: { width: 170, height: 90, channels: 3, background: '#dd8240' } }).png().toFile(info.path!)
      await click('重新关联原目录…')
      await until(async () => (await spaceList()).some(s => s.id === secondLink.id), '原目录关联未接续')
      if (process.platform !== 'win32') {
        chmodSync(info.path!, 0o000)
        try {
          await click('核对整个空间')
          await until(() => js("document.querySelector('[aria-label=未完成的文件核对]')?.textContent.includes('封面.png')"), '未展示原件读取失败')
        } finally { chmodSync(info.path!, 0o600) }
        await click('重试未完成项')
      } else await click('核对整个空间')
      await until(async () => (await callCore(lib.core, 'listDirectoryUpdates', secondLink.id, 0)).total === 1, '新版未被核对')
      await until(() => js("document.querySelector('[aria-label=原地文件更新] button')?.getAttribute('aria-expanded') === 'true'"), '待接纳列表未展开')
      await click('预览更新…')
      const compare = "document.querySelector('[aria-label=预览内容更新]')"
      await until(() => js(compare + "?.querySelector('img')?.naturalWidth === 170"), '对照页未解码新版图片')
      assert.ok(await js(compare + "?.textContent.includes('旧内容不可读取')"))
      await click('暂不更新'); await click('完成')
      assert.equal((await callCore(lib.core, 'get', [id]))[0].blocks.file.data.path, previous)
      await click('预览更新…'); await click('接纳到本仓库')
      await until(() => js("document.querySelector('.file-storage-dialog')?.textContent.includes('本仓库已接纳新版')"), '更新未提交')
      await click('完成')
      await until(() => js("document.querySelector('[aria-label=原地文件更新]')?.textContent.includes('没有待接纳更新')"), '接纳后仍然待办')
      await until(async () => {
        const { blocks } = (await callCore(lib.core, 'get', [id]))[0]
        return blocks.image?.data.width === 170 && !!blocks.thumb
      }, '新图片未重新提取尺寸和缩略图')
      await readImage(id, 170)
      assert.equal((await callCore(other.core, 'get', [secondId]))[0].blocks.file.data.path, previous)
      assert.equal((await callCore(other.core, 'fileStorageInfo', secondId)).hasUpdate, true)
      writeFileSync(stateFile, JSON.stringify({ ok: true, id, secondId, spaceId: (await spaceList())[0].id }))
    } finally {
      dialog.showOpenDialog = picker; dialog.showMessageBox = confirm
      if (other) {
        const second = other.win
        second.close(); await until(() => second.isDestroyed(), '第二个仓库未关闭'); await allClosed()
      }
    }
    return
  }
  if (process.env.CAPTURE_FLOW === 'directoryspaceidentity') {
    const west = join(source, '原画'), east = join(source, '归档'), draft = join(west, '草稿.md')
    mkdirSync(west, { recursive: true }); mkdirSync(east); writeFileSync(draft, '第一版')
    const picker = dialog.showOpenDialog
    try {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [source] })) as typeof picker
      await click('关联或新建空间…'); await click('关联原地目录…'); await click('原画')
      const [space] = await spaceList()
      const page = async (folder: string | null): Promise<DirectoryPage> =>
        js(`window.bridge.spaces.directories.page(${JSON.stringify(space.id)},${JSON.stringify(folder)},0,false)`)
      const checkAll = async () => {
        await click('核对整个空间')
        await until(() => js("document.querySelector('[aria-label=原地目录]')?.textContent.includes('核对完成 · 已检查 3 个目录') && document.querySelector('.directory-navigation strong')?.textContent.endsWith(' / 原画')"), '全空间核对未完成')
      }
      const dirs = await page(null), sourceFolder = dirs.items.find(f => f.name === '原画')!, destFolder = dirs.items.find(f => f.name === '归档')!
      const [original] = (await page(sourceFolder.id)).items
      await click('草稿.md'); await click('核对内容版本')
      const waitVersion = (version: number) => until(() => js(`document.querySelector('.directory-file-detail')?.textContent.includes('已核对版本 ${version} · SHA-256')`), '内容版本不符')
      await waitVersion(1)
      const moved = join(east, '定稿.md'), copy = join(east, '副本.md')
      renameSync(draft, moved)
      copyFileSync(moved, copy)
      await checkAll()
      await click('上一级目录'); await click('归档')
      const target = await page(destFolder.id)
      assert.equal(target.items.find(f => f.name === '定稿.md')?.id, original.id)
      assert.notEqual(target.items.find(f => f.name === '副本.md')?.id, original.id)
      utimesSync(moved, 1000, 1000)
      await click('刷新目录'); await click('定稿.md'); await click('核对内容版本'); await waitVersion(1)
      writeFileSync(draft, '第二版'); renameSync(draft, moved)
      await click('刷新目录'); await click('定稿.md'); await click('核对内容版本'); await waitVersion(2)
      assert.equal((await page(destFolder.id)).items.find(f => f.name === '定稿.md')?.id, original.id)
      rmSync(moved)
      await click('刷新目录'); await click('原位置缺失 · 1')
      await until(() => js("document.querySelector('section[aria-label=原位置缺失]')?.textContent.includes('定稿.md')"), '缺失位置未保留')
      assert.deepEqual(await files(), initial)
      writeFileSync(join(dir, 'directoryspaceidentity-result.json'), JSON.stringify({ ok: true, fileId: original.id, revision: 2 }))
    } finally { dialog.showOpenDialog = picker }
    return
  }
  if (process.env.CAPTURE_FLOW === 'directoryspaceresume') {
    const prior = JSON.parse(readFileSync(join(dir, 'directoryspace-result.json'), 'utf8'))
    assert.equal((await spaceList())[0].id, prior.id)
    await click('只读工程')
    await click('原画')
    await click('封面.png')
    await until(() => js('document.querySelector("img.directory-image")?.naturalWidth === 120'), '重开后图片不可读')
    await manage(); await click('解除目录关联')
    await until(async () => !(await spaceList()).length, '解除未保存')
    assert.deepEqual(readdirSync(source), ['原画'])
    assert.deepEqual(await files(), initial)
    writeFileSync(join(dir, 'directoryspaceresume-result.json'), JSON.stringify({ ok: true }))
    return
  }
  mkdirSync(folder, { recursive: true })
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#548090' } }).png().toBuffer()
  writeFileSync(file, bytes); chmodSync(file, 0o444); chmodSync(folder, 0o555); chmodSync(source, 0o555)
  const picker = dialog.showOpenDialog
  try {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [source] })) as typeof picker
    await click('关联或新建空间…')
    await click('关联原地目录…')
    await click('原画')
    await click('封面.png')
    await until(() => js('document.querySelector("img.directory-image")?.naturalWidth === 120'), '图片未解码')
    const [s] = await spaceList()
    const directory = async (id: string | null): Promise<DirectoryPage> =>
      js(`window.bridge.spaces.directories.page(${JSON.stringify(s.id)},${JSON.stringify(id)},0,false)`)
    const child = (await directory(null)).items[0].id
    const entry = (await directory(child)).items[0]
    renameSync(source, source + '.offline')
    try {
      await click('刷新目录')
      await until(() => js("document.querySelector('[aria-label=原地目录]')?.textContent.includes('显示上次浏览的清单')"), '离线清单未显示')
      assert.equal((await directory(child)).items[0].id, entry.id)
    } finally { renameSync(source + '.offline', source) }
    await click('刷新目录')
    assert.deepEqual(await files(), initial)
    assert.deepEqual(readdirSync(source), ['原画'])
    assert.deepEqual(readdirSync(folder), ['封面.png'])
    assert.deepEqual(readFileSync(file), bytes)
    writeFileSync(join(dir, 'directoryspace-result.json'), JSON.stringify({ id: s.id, ok: true }))
  } finally { dialog.showOpenDialog = picker }
}
