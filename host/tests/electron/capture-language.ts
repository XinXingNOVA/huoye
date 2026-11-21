import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, Menu, BrowserWindow } from 'electron'
import sharp from 'sharp'
import { chooseCaptureMenu } from './capture'
import { auxiliaryKind, auxiliaryOwner } from '../../src/main/auxiliary-windows'
import { callCore } from '../../src/main/core-client'
import { openLibraries } from '../../src/main/libraries'
import { showLauncher } from '../../src/main/launcher'
import { findSettingsSurface } from './settings-surface'
import { click, script, until } from './theme-settings'

async function settings(owner: BrowserWindow, open: string, page: string) {
  await click(owner, open)
  await until(() => !!findSettingsSurface(owner), 'settings window missing')
  const panel = findSettingsSurface(owner)!
  await click(panel, page)
  return panel
}

async function section(win: BrowserWindow, id: string, label: string) {
  const query = JSON.stringify(`[data-inspector-section="section:${id}"]`)
  await until(() => script(win, `(() => {
    const button = document.querySelector(${query})?.querySelector('h3 button')
    if (!button || !button.textContent.includes(${JSON.stringify(label)})) return false
    if (button.getAttribute('aria-expanded') === 'false') button.click()
    return true
  })()`), label + ' section missing')
}

async function detachTool(owner: BrowserWindow, selector: string, choice: string) {
  const existing = new Set(BrowserWindow.getAllWindows())
  chooseCaptureMenu(choice)
  await script(owner, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  const created = () => BrowserWindow.getAllWindows().find(w => !existing.has(w) && auxiliaryOwner(w) === owner && auxiliaryKind(w)?.startsWith('content:'))
  await until(() => !!created(), 'could not detach ' + selector)
  return created()!
}

async function togglePortrait(win: BrowserWindow, pressed: boolean) {
  const button = "[...document.querySelectorAll('button')].find(b => b.querySelector('.rm-shape-label')?.textContent === 'Portrait')"
  await until(() => script(win, `Boolean(${button}?.checkVisibility())`), 'Portrait unavailable')
  await script(win, `${button}.click()`)
  await until(() => script(win, `${button}.getAttribute('aria-pressed') === '${pressed}'`), 'Portrait selection did not change')
}

async function chooseField(win: BrowserWindow, label: string, value: string) {
  await until(() => script(win, `(() => {
    const select = document.querySelector('select[aria-label=' + CSS.escape(${JSON.stringify(label)}) + ']')
    if (!select?.checkVisibility() || ![...select.options].some(o => o.value === ${JSON.stringify(value)})) return false
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`), label + ' unavailable')
}

export async function runLanguageCapture(launcher: BrowserWindow, dir: string) {
  const picker = dialog.showOpenDialog, stage = process.env.CAPTURE_FLOW!
  try {
    assert(process.env.RM_USER_DATA)
    const hasEnglishMenu = () => Menu.getApplicationMenu()?.items.some(i => i.label === 'File')
    if (stage === 'language-resume') {
      await until(() => script(launcher, 'document.documentElement.lang === "en" && document.body.innerText.includes("Recent libraries")'), 'English preference lost on restart')
      assert(hasEnglishMenu())
      const panel = await settings(launcher, 'App and Plugin Settings', 'Language / 界面语言')
      await click(panel, 'Follow System')
      await until(() => script(launcher, 'document.documentElement.lang === "zh-CN"'), 'following the test system language failed')
    } else {
      const panel = await settings(launcher, '应用与插件设置', '界面语言 / Language')
      await click(panel, 'English')
      await until(() => script(panel, 'document.documentElement.lang === "en"'), 'settings language not updated')
      assert(hasEnglishMenu())
      assert.equal(await script(panel, `Array.from(document.querySelectorAll('[data-settings-section="language"] button')).every(b => b.checkVisibility() && b.scrollWidth <= b.clientWidth + 1)`), true)
      await click(panel, 'Appearance & Themes')
      await until(() => script(panel, `(() => {
        const labels = ['Huoye Standard', 'Silver Gelatin', 'Celadon Study', 'Compact Desk']
        return labels.every(label => {
          const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)
          return button?.checkVisibility() && button.querySelector('img')?.naturalWidth > 0
        }) && !document.querySelector('button[aria-label=Obsidian]')?.checkVisibility()
      })()`), 'featured theme previews did not load or translate')
      await script(panel, "Array.from(document.querySelectorAll('summary')).find(s => s.textContent === 'Classic themes').click()")
      await until(() => script(panel, "document.querySelector('button[aria-label=Obsidian]')?.checkVisibility()"), 'classic themes unavailable')
      await click(panel, 'AI Access · MCP')
      await click(panel, 'Package permissions')
      await until(() => script(panel, "document.querySelector('.mcp-versions') && document.body.innerText.includes('Visual Library')"), 'installed suite name did not translate in permissions')
      await click(panel, 'Development & testing')
      await click(panel, 'Libraries & creation')
      await click(panel, 'Close Settings')
      const home = realpathSync(dir), source = join(home, '插画'), name = 'My Library'
      mkdirSync(source)
      await sharp({ create: { width: 32, height: 48, channels: 3, background: '#5f8473' } }).png().toFile(join(source, '海报.png'))
      let chosen = source
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof picker
      writeFileSync(join(dir, 'english-launcher.png'), (await launcher.webContents.capturePage()).toPNG())
      await click(launcher, 'Create')
      await click(launcher, 'Link Folder…')
      chosen = home
      await click(launcher, 'Choose Location…')
      await script(launcher, `(() => { const el=document.querySelector('#launcher-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(name)}); el.dispatchEvent(new Event('input',{bubbles:true})) })()`)
      await click(launcher, 'Visual Library')
      await click(launcher, 'Create and Open')
      await until(() => openLibraries().some(l => l.root === join(home, name)), 'library did not open')
      const lib = openLibraries().find(l => l.root === join(home, name))!, win = lib.win
      await click(win, 'Preview Items')
      await click(win, 'Add to Library (1)')
      await until(() => script(win, 'document.querySelector("dialog")?.innerText.includes("Added: 1")'), 'collection did not finish')
      await click(win, 'Open Library')
      const { ids } = await callCore(lib.core, 'query', { has: ['file'] })
      assert.equal(ids.length, 1)
      await callCore(lib.core, 'put', ids[0], 'source', { title: '原稿标题', site: 'example.org', url: 'https://example.org/poster' })
      const card = `document.querySelector('[data-entity-id="${ids[0]}"][data-hy-part="resource-card"]')`
      await until(() => script(win, `(() => { const c=${card}; if (!c?.checkVisibility()) return false; c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); return true })()`), 'image card missing')
      await until(() => script(win, `(() => { const b=document.querySelector('[data-fact="type"] button'); if(!b || b.parentElement.parentElement.innerText.indexOf('Type')<0)return false; b.click(); return true })()`), 'Type filter unavailable')
      await until(() => script(win, "document.querySelector('.query-chip-label')?.textContent.includes('Format: PNG')"), 'Type filter did not apply')
      assert.equal(await script(win, "document.querySelector('[data-action-id=\"open\"]')?.textContent"), 'Open')
      await chooseField(win, 'Search in block', 'source')
      assert(await script(win, `document.querySelector('select[aria-label="Search field"] option[value=title]')?.textContent === 'Page title'`))
      await chooseField(win, 'Search in block', '')
      await click(win, 'Display settings')
      await until(() => script(win, `!!document.querySelector('[role=dialog] input[aria-label="Card size"]') && document.querySelector('[role=dialog]').innerText.includes('Default for new pages: Masonry')`), 'masonry settings did not translate')
      await click(win, 'Display settings')
      await click(win, 'Sort')
      await chooseField(win, 'Sort by', JSON.stringify(['file', 'name']))
      await chooseField(win, 'Sort direction', 'asc')
      await click(win, 'Done')
      await until(() => script(win, "document.body.innerText.includes('File · File name Ascending')"), 'sort summary did not translate')
      await section(win, 'rating', 'Rating')
      await script(win, `document.querySelector('[aria-label="Rating: 4/5"]').click()`)
      await until(async () => (await callCore(lib.core, 'get', ids))[0]?.blocks.rating?.data.value === 4, 'rating was not saved')
      await section(win, 'source', 'Source')
      assert(await script(win, `document.querySelector('[title="Open in browser"]')?.textContent === 'https://example.org/poster' && document.body.innerText.includes('原稿标题')`))
      await section(win, 'note', 'Notes')
      await script(win, `(() => {
        const input = document.querySelector('textarea[placeholder="What would you like to remember?"]')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '红色 {name}')
        input.dispatchEvent(new Event('input', { bubbles:true }))
      })()`)
      await until(async () => (await callCore(lib.core, 'get', ids))[0]?.blocks.note?.data.text === '红色 {name}', 'original note was not saved')
      await section(win, 'tags', 'Tags')
      await script(win, `(() => {
        const input = document.querySelector('[placeholder="Add tags and press Enter"]')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '红色')
        input.dispatchEvent(new Event('input', {bubbles:true}))
        input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))
      })()`)
      await until(async () => { const tags = (await callCore(lib.core, 'get', ids))[0]?.blocks.tags?.data.values; return Array.isArray(tags) && tags.includes('红色') }, 'original tag was not saved')
      await togglePortrait(win, true)
      await until(() => script(win, "document.body.innerText.includes('Orientation: Portrait')"), 'orientation chip was not localized')
      const filterWindow = await detachTool(win, '[data-context-tool="host.filters"]', 'Pin tool in new window')
      await until(() => script(filterWindow, "document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Filters · All Items')"), 'bound filter lost the translated source title')
      await togglePortrait(filterWindow, false)
      await until(() => script(win, "!document.body.innerText.includes('Orientation: Portrait')"), 'detached filter did not update the collection')
      await until(() => script(filterWindow, "document.querySelector('[data-family=红色]')?.getAttribute('aria-label')?.startsWith('Red (')"), 'detached palette not localized')
      await until(() => script(filterWindow, "document.body.innerText.includes('红色') && document.body.innerText.includes('Tag groups')"), 'tag data or group heading changed')
      writeFileSync(join(dir, 'english-filters-window.png'), (await filterWindow.webContents.capturePage()).toPNG())
      filterWindow.close()
      await until(() => filterWindow.isDestroyed(), 'filter window did not close')
      await script(win, `${card}.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0 }))`)
      win.showInactive()
      await until(() => script(win, `(() => { const img=${card}?.querySelector('img'); return img?.complete && img.naturalWidth > 0 })()`), 'image preview did not render')
      await script(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      writeFileSync(join(dir, 'english-library.png'), (await win.webContents.capturePage()).toPNG())
      const saved = await callCore(lib.core, 'run','view','saveView',{ title:'全部', query:{scope:'content'}, layout:'masonry' }) as {id:string}
      launcher = showLauncher(false)
      await until(() => script(launcher, 'document.documentElement.lang === "en"'), 'launcher did not inherit English')
      const libraryPanel = await settings(win, 'Open Settings', 'Language / 界面语言')
      await click(libraryPanel, '简体中文')
      await until(() => script(launcher, 'document.documentElement.lang === "zh-CN"'), 'open launcher not synchronized')
      await until(() => script(win, `document.documentElement.lang === 'zh-CN' && document.querySelector('[data-fact="type"]')?.textContent.includes('类型')`), 'selection lost during switch')
      assert.equal(await script(win, "document.querySelector('.query-chip-label')?.textContent.includes('格式： PNG')"), true)
      assert.equal((await callCore(lib.core, 'get', [saved.id]))[0].blocks.view.data.title, '全部')
      await section(win, 'rating', '评分')
      chooseCaptureMenu('移到新窗口')
      await script(win, `document.querySelector('[role="tab"][data-tab][aria-selected="true"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
      const detached = () => BrowserWindow.getAllWindows().find(w => auxiliaryOwner(w) === win && auxiliaryKind(w)?.startsWith('content:'))
      await until(() => !!detached(), 'collection did not detach')
      const child = detached()!
      await until(() => script(child, `document.documentElement.lang === 'zh-CN' && !!${card} && document.querySelector('.query-chip-label')?.textContent.includes('格式： PNG')`), 'detached collection lost its item or query')
      await click(libraryPanel, 'English')
      await until(() => script(child, `document.documentElement.lang === 'en' && !!${card} && document.querySelector('.query-chip-label')?.textContent.includes('Format: PNG')`), 'detached collection did not change language')
      // The inspector follows the active collection, including a collection in a content window.
      await script(child, `${card}.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0 }))`)
      await section(win, 'rating', 'Rating')
      await script(win, `document.querySelector('[aria-label="Rating: 5/5"]').click()`)
      await until(async () => (await callCore(lib.core, 'get', ids))[0]?.blocks.rating?.data.value === 5, 'inspector did not update the detached selection')
      await section(win, 'tags', 'Tags')
      assert(await script(win, "document.querySelector('[title=\"Filter by this tag\"]')?.textContent === '红色'"))
      writeFileSync(join(dir, 'english-detached-collection.png'), (await child.webContents.capturePage()).toPNG())
      await until(() => script(launcher, 'document.documentElement.lang === "en"'), 'launcher not synchronized')
      await click(child, 'Save as View…')
      const viewName = '我的 Portrait 精选'
      await script(child, `(() => {
        const el = document.querySelector('input[aria-label="View name"]')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(viewName)})
        el.dispatchEvent(new Event('input', {bubbles:true}))
      })()`)
      await click(child, 'Add rule')
      await chooseField(child, 'Rule block', 'image-filter.geometry')
      await chooseField(child, 'Rule field', 'shape')
      await click(child, 'Confirm rule')
      await until(() => script(child, "document.querySelector('dialog [role=alert]')?.textContent === 'Add at least one value.'"), 'missing value hint was not translated')
      await click(libraryPanel, '简体中文')
      await until(() => script(child, "document.querySelector('dialog [role=alert]')?.textContent === '请添加至少一个值'"), 'open validation hint did not change language')
      await click(libraryPanel, 'English')
      await chooseField(child, 'Rule value', '竖图')
      const selected = (label: string) => `document.querySelector('select[aria-label=' + CSS.escape(${JSON.stringify(label)}) + ']')?.selectedOptions[0]?.textContent`
      assert.equal(await script(child, selected('Rule value')), 'Portrait')
      await click(libraryPanel, '简体中文')
      await until(() => script(child, `${selected('条件值')} === '竖图' && document.querySelector('input[aria-label="视图名称"]')?.value === ${JSON.stringify(viewName)}`), 'draft lost on language change')
      await click(libraryPanel, 'English')
      await until(() => script(child, `${selected('Rule value')} === 'Portrait'`), 'detached editor did not return to English')
      await click(child, 'Confirm rule')
      await click(child, 'Save view')
      await until(() => script(child, `!document.querySelector('dialog[open]') && document.querySelector('.toolbar-name')?.textContent === ${JSON.stringify(viewName)}`), 'view was not saved')
      const views = await callCore(lib.core, 'query', { scope: 'all', has: ['view'] })
      const data = (await callCore(lib.core, 'get', views.ids)).find(v => v.blocks.view?.data.title === viewName)?.blocks.view?.data
      const query = data?.query as import('../../src/shared/query').Query | undefined
      assert(query, 'saved view missing from the library')
      assert(query.where?.some(c => c.kind === 'image-filter.geometry' && c.field === 'shape' && c.op === 'eq' && c.value === '竖图'))
      assert.deepEqual(query.sort, { kind: 'file', field: 'name' })
      assert.equal(query.dir, 'asc')
    }
    writeFileSync(join(dir, stage + '-result.json'), JSON.stringify({ passed: true }))
  } catch (e) {
    console.error('[language]', e)
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed())
      console.error('[language UI]', await script(win, 'document.body.innerText').catch(() => ''))
    process.exitCode = 1
  } finally { dialog.showOpenDialog = picker; app.quit() }
}
