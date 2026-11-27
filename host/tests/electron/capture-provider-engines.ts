import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { developmentDirectories } from '../../src/main/plugin-packages'
import type { PackagePreview } from '../../src/shared/external-plugins'
import { findSettingsSurface } from './settings-surface'

const capability = 'sample/file.measure@1'
const kind = 'measure-test.result'
async function until(label: string, check: () => Promise<unknown>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw Error(label)
}

export async function providerEnginesFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const ready = () => until('工作台未挂载', () => js("!!document.querySelector('[aria-label=打开设置]')").catch(() => false))
  const reload = async () => {
    await Promise.all([once(win.webContents, 'did-finish-load', { signal: AbortSignal.timeout(20000) }), reloadLibrary(lib)])
    await ready()
  }
  const status = async () => (await callCore(lib.core, 'info')).capabilities.find(c => c.id === capability)
  await ready()
  const files = ['engine-a.hyplugin', 'consumer.hyplugin'].map(f => join(dir, f))
  const preview: PackagePreview = await js('window.bridge.packages.previewFiles(' + JSON.stringify(files) + ')')
  await js('window.bridge.packages.install(' + JSON.stringify(preview.token) + ')')
  const changes = preview.items.map(p => ({ hash: p.hash, enabled: true }))
  const disabled = (await callCore(lib.core, 'plugins')).filter(p => !p.external && p.chosen).map(p => p.id)
  await js('window.bridge.packages.apply(' + JSON.stringify({ disabled, changes }) + ')')
  const source = join(dir, 'engine-b')
  const dev = developmentDirectories()
  await dev.setDirectory(lib.root, source)
  await dev.prepare(lib.root, [source])
  const applyBuild = async (previous?: string) => {
    await until('开发引擎未完成构建', async () => {
      const row = dev.state(lib.root).rows.find(p => p.source === source)
      if (row?.problem || row?.build?.state === 'error') throw Error(row.problem || row.build?.message)
      if (!row?.availableHash || row.availableHash === previous || row.build?.state !== 'ready') return false
      dev.apply(lib.root, [{ source, hash: row.availableHash }])
      return true
    })
    return dev.state(lib.root).rows.find(p => p.source === source)!.appliedHash
  }
  const original = await applyBuild()
  await reload()
  assert.equal((await status())?.state, 'unavailable')
  const choose = async (id: string, scope: 'application' | 'library' = 'application', effective = id) => {
    await js("document.querySelector('[aria-label=打开设置]').click()")
    await until('找不到计算引擎设置', async () => findSettingsSurface(win)?.webContents.executeJavaScript(
      "[...document.querySelectorAll('.application-settings-nav button')].find(b => b.textContent.trim()==='计算引擎')?.click() ?? !!document.querySelector('[data-settings-section=providers] select')"))
    const settings = findSettingsSurface(win)!
    const page = (code: string) => settings.webContents.executeJavaScript(code)
    if (scope === 'library') {
      assert(await page("(() => { const b=[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='本库覆盖'); b?.click(); return !!b })()"))
      await until('本库覆盖未显示', () => page(`!!document.querySelector('select option[value="@auto"]')`))
    }
    const selectEngine = async (value: string) => {
      assert(await page(`(() => { const s=document.querySelector('select[aria-label="${capability}"]'); if (!s || s.disabled || !Array.from(s.options).some(o=>o.value==='${value}')) return false; s.value='${value}';s.dispatchEvent(new Event('change',{bubbles:true}));return true })()`))
      await until('偏好未保存', () => js(`window.bridge.providers.list().then(rows=>rows.some(r=>r.id==='${capability}' && (r.${scope === 'library' ? 'override' : 'preferred'} ?? '')==='${value}' ${scope === 'library' ? "&& r.preferred==='engine-a'" : ''}))`))
    }
    await selectEngine(id)
    // 由真实设置控件更改偏好，重载前依然使用原会话。
    assert.notEqual((await status())?.provider, id)
    const notice = "!!document.querySelector('[data-settings-section=providers] [role=status]')?.textContent.includes('引擎选择已保存')"
    await until('未提示重载当前仓库', () => page(notice))
    if (scope === 'application') {
      await selectEngine('')
      await until('改回原选择仍提示重载', async () => !await page(notice))
      await selectEngine(id)
      await until('重新选择后未提示重载', () => page(notice))
    }
    await until('重载按钮未就绪', () => page("[...document.querySelectorAll('button')].some(b => b.textContent.trim()==='重载当前仓库' && !b.disabled)"))
    await Promise.all([
      once(win.webContents, 'did-finish-load', { signal: AbortSignal.timeout(20000) }),
      page("[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='重载当前仓库').click()")
    ])
    await ready()
    assert.deepEqual(await status(), { id: capability, state: 'ready', provider: effective })
    assert.equal(await js('window.bridge.providers.list().then(rows=>rows.some(row=>row.pendingReload))'), false)
  }
  await choose('engine-a')
  const file = join(dir, 'new-sample.txt'), content = '活页能力测试\n'
  writeFileSync(file, content)
  const [item] = await callCore(lib.core, 'ingest', [{ type: 'file', path: file }])
  const result = (engine: string) => until('未得到加工结果 ' + engine, async () => {
    const [entity] = await callCore(lib.core, 'get', [item])
    assert.deepEqual(entity.failures, {})
    const block = entity.blocks[kind]
    return block?.data.engine === engine && block.data.bytes === Buffer.byteLength(content)
  })
  await result('engine-a-v1')
  await choose('engine-b', 'library')
  await result('engine-b-v1')
  await js("document.querySelector('[aria-label=打开设置]').click()")
  await until('引擎包的设置页未显示', async () => findSettingsSurface(win)?.webContents.executeJavaScript(
    "(() => { const el=document.querySelector('[data-settings-section=\"engine-b.settings\"]'); if (el?.checkVisibility() && el.textContent.includes('Engine controls')) return true; [...document.querySelectorAll('.settings-plugins-nav button')].find(b=>b.textContent.includes('engine-b'))?.click();return false })()"))
  const entry = join(source, 'provider.ts')
  writeFileSync(entry, readFileSync(entry, 'utf8').replace('engine-b-v1', 'engine-b-v2'))
  const upgraded = await applyBuild(original)
  assert.notEqual(upgraded, original)
  await reload()
  await result('engine-b-v2')
  await dev.clear(lib.root)
  await reload()
  assert.equal((await status())?.state, 'unavailable')
  const processing = await callCore(lib.core, 'processingStatus', { ids: [item], kinds: [kind] })
  assert.match(JSON.stringify(processing), /blocked/)
  await choose('', 'library', 'engine-a')
  await result('engine-a-v1')
  const bound = await callCore(lib.core, 'externalPlugins')
  assert.equal(bound.find(p => p.manifest.id === 'measure-test')?.hash, changes[1].hash)
  writeFileSync(join(dir, 'provider-engines.json'), JSON.stringify({
    item, bytes: Buffer.byteLength(content), consumerHash: changes[1].hash, original, upgraded,
    results: ['engine-a-v1', 'engine-b-v1', 'engine-b-v2', 'blocked', 'engine-a-v1']
  }, null, 2))
}
