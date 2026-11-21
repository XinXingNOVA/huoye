import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { localPackages } from '../../src/main/plugin-packages'
import { openThemeSettings } from './theme-settings'
import { checkThemePackage } from './capture-theme-package'
import { executeUiCommand } from './capture-command'
import { findSettingsSurface, settingsScript } from './settings-surface'

const evaluate = (win: BrowserWindow) => (code: string) => win.webContents.executeJavaScript(code, true)
const pause = () => new Promise(resolve => setTimeout(resolve, 80))
async function until(check: () => Promise<unknown> | unknown, label: string) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause() }
  throw Error(label)
}
const table = 'document.querySelector(\'[role="region"][aria-label="素材表格"]\')'
const rowSelector = (id: string) => JSON.stringify('[data-entity-id="' + id + '"]')

export async function themeFlow(owner: BrowserWindow, dir: string, choose: (label: string) => void) {
  const main = evaluate(owner)
  await until(() => main("!!document.querySelector('[aria-label=\"打开设置\"]')"), '工作台未就绪')
  const pack = localPackages().list().find(p => p.manifest.id === 'table')!
  await main(`window.bridge.packages.apply({disabled:[],changes:[{hash:${JSON.stringify(pack.hash)},enabled:true}]})`)
  await reloadLibrary(libraryOf(owner.webContents)!)
  await until(() => main("!!document.querySelector('[aria-label=\"打开设置\"]')"), '重载失败')
  const { core, id: libraryId } = libraryOf(owner.webContents)!
  const query = { has: ['text'] }
  const { ids } = await callCore(core, 'query', query)
  assert.equal(ids.length, 100_000)
  const { id } = await callCore(core, 'run', 'view', 'saveView', { title: '资料清单', query, layout: 'table', options: {} }) as { id: string }
  await executeUiCommand(main, 'host.saved-view.' + id)

  const openAppearance = () => openThemeSettings(owner)

  async function switchTheme(label: string, densityLabel?: string) {
    await openAppearance()
    const ui = (code: string) => settingsScript(owner, code)
    const preset = JSON.stringify('button[aria-label="' + label + '"]')
    await until(() => ui(`!!document.querySelector(${preset})`), '主题预设缺失')
    await ui(`document.querySelector(${preset}).click()`)
    await until(() => ui(`document.querySelector(${preset}).getAttribute('aria-pressed') === 'true'`), '主题未选中')
    if (densityLabel) {
      const option = `[...document.querySelectorAll('[aria-label="界面密度"] [role="radio"]')].find(b => b.textContent === ${JSON.stringify(densityLabel)})`
      await ui(`${option}.click()`)
      await until(() => ui(`${option}.getAttribute('aria-checked') === 'true'`), '手动密度未生效')
    }
    await ui(`document.querySelector('[aria-label="关闭设置"]').click()`)
    await until(() => !findSettingsSurface(owner), '设置窗口未关闭')
  }

  async function hit(win: BrowserWindow, index: number, height: number) {
    const js = evaluate(win), selector = rowSelector(ids[index])
    await until(() => js(`(() => {
      const el=${table}, row=el?.querySelector(${selector})
      return row?.getBoundingClientRect().height === ${height} && Math.abs(el.scrollTop - ${index * height}) < 1
    })()`), '滚动锚点或行高错误 ' + index + ' / ' + height)
    const [record] = await callCore(core, 'get', [ids[index]])
    await until(() => js(`${table}.querySelector(${selector}).textContent.includes(${JSON.stringify(record.blocks.text.data.content)})`), '记录正文未显示')
    const point = await js(`(() => {
      const el=${table}, r=el.querySelector(${selector}).getBoundingClientRect()
      const x=Math.round(el.getBoundingClientRect().left+40), y=Math.round(r.top+r.height/2)
      return { x,y, id:document.elementFromPoint(x,y)?.closest('[data-entity-id]')?.dataset.entityId,
        mounted:el.querySelectorAll('[data-entity-id]').length }
    })()`)
    assert.equal(point.id, ids[index]); assert(point.mounted < 100)
    win.focus()
    const clickRow = (y: number) => {
      for (const type of ['mouseDown', 'mouseUp'] as const) {
        win.webContents.sendInputEvent({ type, x: point.x, y, button: 'left', clickCount: 1 })
      }
    }
    clickRow(point.y + height)
    await until(() => js(`${table}.querySelector(${rowSelector(ids[index + 1])}).hasAttribute('data-selected')`), '相邻行命中错误')
    clickRow(point.y)
    await until(() => js(`${table}.querySelector(${selector}).hasAttribute('data-selected')`), '实际点击未选中目标记录')
    return point.mounted as number
  }
  const shot = async (win: BrowserWindow, name: string) => writeFileSync(join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG())

  const index = 80_000
  await switchTheme('青瓷书房')
  await until(() => main(`!!${table}?.querySelector('[data-entity-id]')`), '表格未打开')
  await main(`${table}.scrollTop = ${index * 40}`)
  const comfortable = await hit(owner, index, 40)
  await shot(owner, 'theme-study')
  await switchTheme('紧凑资料台')
  const compact = await hit(owner, index, 32)
  await shot(owner, 'theme-desk')
  const tab = await main(`window.bridge.loadWorkspace(${JSON.stringify(libraryId)}).then(w=>w.active)`)
  choose('移到新窗口')
  await main(`document.querySelector('[data-tab="${tab}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  const contentWindow = () => BrowserWindow.getAllWindows().find(w => w !== owner && w.webContents.getURL() === 'about:blank')
  await until(() => !!contentWindow(), '标签未移入独立小窗')
  const child = contentWindow()!, js = evaluate(child)
  await until(() => js(`!!${table}?.querySelector('[data-entity-id]')`), '小窗表格未就绪')
  await js(`${table}.scrollTop = ${(index + 1) * 32}`)
  await hit(child, index + 1, 32)
  await switchTheme('青瓷书房')
  await until(() => js("document.documentElement.dataset.theme === 'celadon-reading'"), '小窗未收到主题')
  await hit(child, index + 1, 40)
  await js(`${table}.scrollTop = ${table}.scrollHeight`)
  const [last] = await callCore(core, 'get', [ids.at(-1)!])
  await until(() => js(`${table}.querySelector(${rowSelector(last.id)})?.textContent.includes(${JSON.stringify(last.blocks.text.data.content)})`), '表格末行内容未显示')
  await shot(child, 'theme-child')
  await switchTheme('青瓷书房', '紧凑')
  await until(() => js(`(() => {
    const el = ${table}, end = el.querySelector(${rowSelector(last.id)})
    return end?.getBoundingClientRect().height === 32 && Math.abs(el.scrollHeight-el.scrollTop-el.clientHeight) < 1
  })()`), '手动切换密度后表格底部越界')
  await js(`(() => {
    const rect = ${table}.querySelector(${rowSelector(last.id)}).getBoundingClientRect()
    document.elementFromPoint(rect.left + 40, rect.top + rect.height / 2)
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })()`)
  const reader = '[role="article"][aria-label="阅读正文"]'
  let readingWindow = child
  await until(async () => {
    for (const win of [child, owner]) {
      if (await evaluate(win)(`document.querySelector('${reader}')?.checkVisibility()`)) { readingWindow = win; return true }
    }
    return false
  }, '文字阅读器未打开')
  const reading = evaluate(readingWindow)
  const font = () => reading(`(() => {
    const nodes = document.createTreeWalker(document.querySelector('${reader}'), NodeFilter.SHOW_TEXT)
    while (nodes.nextNode()) {
      if (nodes.currentNode.textContent === ${JSON.stringify(last.blocks.text.data.content)}) {
        return getComputedStyle(nodes.currentNode.parentElement).fontFamily
      }
    }
  })()`)
  await until(async () => String(await font()).includes('Songti SC'), '书房主题未应用于实际正文')
  await shot(readingWindow, 'theme-reading')
  await switchTheme('紧凑资料台')
  await until(async () => String(await font()).includes('system-ui'), '切换主题后正文没有更新')
  await checkThemePackage(owner, child, readingWindow, dir, openAppearance)
  writeFileSync(join(dir, 'theme-result.json'), JSON.stringify({ total: ids.length, index, comfortable, compact, child: true }))
}
