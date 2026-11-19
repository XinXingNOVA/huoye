import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { dialog, type BrowserWindow } from 'electron'
import { openLibraries } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { SpaceBindingInfo } from '../../src/shared/file-spaces'

export async function spaceDiskFlow(win: BrowserWindow, dir: string) {
  const lib = openLibraries().find(l => l.win === win)!
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const until = async (check: () => Promise<unknown>, label: string) => {
    for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(label)
  }
  const click = (label: string) => until(() => js(`(()=>{const e=[...document.querySelectorAll('button,.nav-item')].find(e=>e.checkVisibility()&&(e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e||e.disabled)return false;e.click();return true})()`), '不能点击 ' + label)
  const diskPage = (space: SpaceBindingInfo) => js(`window.bridge.spaces.disk.page(${JSON.stringify(space.root)},{spaceId:${JSON.stringify(space.id)}})`)
  const rowClick = (name: string, label: string) => until(() => js(`(()=>{const row=[...document.querySelectorAll('.space-disk-list li')].find(e=>e.textContent.includes(${JSON.stringify(name)}));const b=[...(row?.querySelectorAll('button')??[])].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`), '不能处理 ' + name)
  const settled = (ids: string[]) => until(async () => (await callCore(lib.core, 'get', ids)).every(v => v.blocks.image || v.blocks.body), '新文件未完成原生加工')
  try {
    if (process.env.CAPTURE_FLOW === 'spacediskresume') {
      const saved = JSON.parse(readFileSync(join(dir, 'disk-saved.json'), 'utf8'))
      const image = (await callCore(lib.core, 'get', [saved.imageId]))[0]
      assert.equal(image.blocks.image.data.width, 240)
      assert.equal(image.blocks.file.data.name, '保留名称.png')
      assert.equal((await callCore(lib.core, 'fileStorageInfo', saved.textId)).contentVersion, saved.textVersion)
      const page = await diskPage(saved.space)
      assert.equal(page.total, 1); assert.equal(page.pending.length, 0); assert(page.items[0].replacement)
      await click('文件空间'); await click('磁盘检查')
      await until(() => js("document.querySelector('.space-disk-list')?.textContent.includes('历史版')"), '失配历史未恢复显示')
      writeFileSync(join(dir, 'spacediskresume-result.json'), JSON.stringify({ ok: true })); return
    }
    const imagePath = join(dir, '外部修改图片.png'), textPath = join(dir, '需要定位的文字.md')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#5588aa' } }).png().toFile(imagePath)
    writeFileSync(textPath, '# 原位置测试\n\n内容保持相同。')
    const imported = await callCore(lib.core, 'importToLibrary', [{ type: 'file', path: imagePath }, { type: 'file', path: textPath }], { requestId: randomUUID() })
    assert.equal(imported.errors.length, 0)
    const [imageId, textId] = imported.items.map(v => v.id); await settled([imageId, textId])
    await callCore(lib.core, 'patch', imageId, 'file', { name: '保留名称.png' })
    const space = (await callCore(lib.core, 'listFileSpaces')).find(s => s.default)!
    const originalImage = await callCore(lib.core, 'fileStorageInfo', imageId), originalText = await callCore(lib.core, 'fileStorageInfo', textId)
    const reference = String((await callCore(lib.core, 'get', [textId]))[0].blocks.file.data.path)
    writeFileSync(originalImage.path!, await sharp({ create: { width: 240, height: 160, channels: 3, background: '#bb7733' } }).png().toBuffer())
    const moved = join(dir, '外部移动的位置.md'); renameSync(originalText.path!, moved)
    await click('文件空间'); await click('磁盘检查'); await click('快速检查')
    await until(() => js("document.querySelector('.space-disk-check')?.textContent.includes('检查完成')"), '磁盘检查未完成')
    const page = await diskPage(space); assert.equal(page.total, 2)
    assert(page.items.some((v: { state: string }) => v.state === 'modified')); assert(page.items.some((v: { state: string }) => v.state === 'missing'))
    await rowClick('外部修改图片.png', '确认修改…')
    await until(() => js("!!document.querySelector('[aria-label=\"确认磁盘变化处理\"]')"), '确认修改面板未显示')
    await new Promise(r => setTimeout(r, 250))
    writeFileSync(join(dir, 'disk-confirm.png'), (await win.webContents.capturePage()).toPNG())
    // 确认前再次保存：拒绝过期预览，刷新清单不能吞掉错误。
    writeFileSync(originalImage.path!, await sharp({ create: { width: 240, height: 160, channels: 3, background: '#445533' } }).png().toBuffer())
    await click('确认处理')
    await until(() => js("document.querySelector('.space-disk-check [role=alert]')?.textContent.includes('PREVIEW_CHANGED')"), '预览失效错误未保留')
    await new Promise(r => setTimeout(r, 200))
    assert(await js("document.querySelector('.space-disk-check [role=alert]')?.textContent.includes('PREVIEW_CHANGED')"))
    assert.equal((await callCore(lib.core, 'fileStorageInfo', imageId)).currentOrdinal, 1)
    await rowClick('外部修改图片.png', '确认修改…')
    await until(() => js("!document.querySelector('.space-disk-check [role=alert]') && [...document.querySelectorAll('button')].some(b=>b.textContent==='确认处理'&&!b.disabled)"), '未能重新预览')
    await click('确认处理')
    await until(async () => (await callCore(lib.core, 'fileStorageInfo', imageId)).currentOrdinal === 2, '外部修改未登记')
    assert.equal((await callCore(lib.core, 'fileStorageInfo', imageId)).contentOrdinal, 1)
    await click('文件')
    await until(() => js(`(()=>{const r=[...document.querySelectorAll('.space-file-row-wrap')].find(e=>e.textContent.includes('外部修改图片.png'));const b=r?.querySelector('.space-file-inspect');if(!b||b.disabled)return false;b.click();return true})()`), '无法打开版本详情')
    await until(() => js("(()=>{const b=document.querySelector('.space-version-actions button');if(!b||b.disabled)return false;b.click();return true})()"), '不能预览接纳')
    await until(() => js("document.querySelector('[aria-label=\"预览内容更新\"]')?.textContent.includes('旧内容不可读取')"), '损坏旧版挡住新内容预览')
    await new Promise(r => setTimeout(r, 250))
    writeFileSync(join(dir, 'disk-adopt.png'), (await win.webContents.capturePage()).toPNG())
    await click('接纳到本仓库')
    await until(async () => (await callCore(lib.core, 'get', [imageId]))[0].blocks.image?.data.width === 240, '接纳后派生图像未更新')
    assert.equal((await callCore(lib.core, 'get', [imageId]))[0].blocks.file.data.name, '保留名称.png')
    await click('磁盘检查')
    const pick = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [moved] })) as typeof dialog.showOpenDialog
    try {
      await rowClick('需要定位的文字.md', '重新定位…')
      await until(() => js("document.querySelector('[aria-label=\"确认磁盘变化处理\"]')?.textContent.includes('修复存储位置')"), '重新定位未核对内容')
    } finally { dialog.showOpenDialog = pick }
    await click('确认处理')
    await until(async () => (await callCore(lib.core, 'fileStorageInfo', textId)).state === 'available', '原引用未恢复读取')
    assert.equal(String((await callCore(lib.core, 'get', [textId]))[0].blocks.file.data.path), reference)
    const response = await js(`fetch(${JSON.stringify(`lib://${lib.id}/${reference}`)}).then(async r=>({ok:r.ok,text:await r.text()}))`)
    assert(response.ok); assert.match(response.text, /内容保持相同/)
    assert.equal(readFileSync(moved, 'utf8'), readFileSync(textPath, 'utf8'))
    await click('完整检查'); await until(() => js("document.querySelector('.space-disk-check')?.textContent.includes('检查完成')"), '完整检查未完成')
    assert.equal((await diskPage(space)).total, 1)
    win.setSize(960, 760); await new Promise(r => setTimeout(r, 150))
    assert(await js('document.documentElement.scrollWidth<=window.innerWidth'), '窄窗口横向溢出')
    writeFileSync(join(dir, 'disk-list.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(join(dir, 'disk-saved.json'), JSON.stringify({ space, imageId, textId, textVersion: originalText.contentVersion }))
    writeFileSync(join(dir, 'spacedisk-result.json'), JSON.stringify({ ok: true, imported: 2, checks: ['快速与完整检查', '确认外部修改', '旧版失配预览', '接纳与原生加工', '重新定位与原引用', '窄窗'] }))
  } catch (error) {
    writeFileSync(join(dir, 'disk-error.txt'), String(error) + '\n' + await js('document.body.innerText'))
    writeFileSync(join(dir, 'disk-error.png'), (await win.webContents.capturePage()).toPNG()); throw error
  }
}
