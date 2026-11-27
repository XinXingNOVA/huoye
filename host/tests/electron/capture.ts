import { playbackFlow } from './capture-playback'
import { paletteFlow } from './capture-palette'
import { pluginInputFlow } from './capture-plugin-input'
import { pluginDataFlow } from './capture-plugin-data'
import { themeReadersFlow } from './capture-theme-readers'
import { libraryThemesFlow } from './capture-library-themes'
import { themePartsFlow } from './capture-theme-parts'
import { themeFlow } from './capture-theme'
import { uiKitFlow } from './capture-ui-kit'
import { contentWindowFlow } from './capture-content-window'
import { settingsWindowFlow } from './capture-settings-window'
import { pluginSuitesFlow } from './capture-plugin-suites'
import { tagPluginsFlow } from './capture-tag-plugins'
import { inspectorFlow } from './capture-inspector-actions'
import { compareStyles } from './compare-styles'
import { uiExtensionsFlow } from './capture-ui-extensions'
import { contextToolsFlow } from './capture-context-tools'
import { workbenchServicesFlow } from './capture-workbench-services'
import { packageInstallFlow } from './capture-package-install'
import { pluginPresetsFlow } from './capture-plugin-presets'
import { workbenchPresetsFlow } from './capture-workbench-presets'
import { browsingLayoutFlow } from './capture-browsing-layout'
import { collectionSurfaceFlow } from './capture-collection-surface'
import { fileEditingFlow } from './capture-file-editing'
import { sourceMcpFlow } from './capture-source-mcp'
import { spaceItemsFlow } from './capture-space-items'
import { directoryMaintenanceFlow } from './capture-directory-maintenance'
import { directorySpaceFlow } from './capture-directory-space'
import { spaceDiskFlow } from './capture-space-disk'
import { openWithFlow } from './capture-open-with'
import { queryViewsFlow } from './capture-query-views'
import { sharedEditingFlow } from './capture-shared-editing'
import { pageInstancesFlow } from './capture-page-instances'
import { pageLifecycleFlow } from './capture-page-lifecycle'
import { editorLayoutFlow } from './capture-editor-layout'
import { sidebarLayoutFlow } from './capture-sidebar-layout'
import { performanceFlow } from '../performance/capture'
import { developmentDirectoryFlow } from './capture-development-directory'
import { itemDisposalFlow } from './capture-item-disposal'
import { spaceDisposalFlow } from './capture-space-disposal'
import { spaceRefreshFlow } from './capture-space-refresh'
import { fileSpaceForgetFlow } from './capture-file-space-forget'
import { fileEditsFlow } from './capture-file-edits'
import { versionLifecycleFlow } from './capture-version-lifecycle'
import { fileUpdatesFlow } from './capture-file-updates'
import { spaceVersionsFlow } from './capture-space-versions'
// 截图模式（开发用）：CAPTURE_DIR=<目录> 时，窗口不显示，按流程操作并截图，然后退出。
// 用于在没有人操作时检查界面。CAPTURE_FLOW=restore 时只截恢复后的第一屏（检查工作区恢复）。

import { execFileSync } from 'node:child_process'
import { queriesFlow } from './capture-queries'
import { transferFlow } from './capture-transfer'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, BrowserWindow, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { showLauncher } from '../../src/main/launcher'
import { pdfNotesFlow } from './capture-pdf'
import { scopedSearchFlow } from './capture-search'
import { mcpCreateFlow } from './capture-mcp-create'
import { tablePluginsFlow } from './capture-table'
import { uiApiFlow } from './capture-ui-api'
import { dataCoreFlow } from './capture-data'
import { managementFlow } from './capture-management'
import { studioExtensionsFlow } from './capture-studio-extensions'
import { providerEnginesFlow } from './capture-provider-engines'
import { comicReadsFlow } from './capture-comic-reads'
import { mediaEditionsFlow } from './capture-media-editions'
import { sharedRuntimesFlow } from './capture-shared-runtimes'
import { nativeEnginesFlow } from './capture-native-engines'
import { mediaHeavyFlow } from './capture-media-heavy'
import { mediaCapabilitiesFlow } from './capture-media-capabilities'
import { audioFlow } from './capture-audio'
import { audioCoverFlow } from './capture-audio-cover'
import { packagesFlow } from './capture-packages'
import { packagedBuiltinsFlow } from './capture-packaged-builtins'
import { pluginDefaultsFlow } from './capture-plugin-defaults'
import { tagsTableFlow } from './capture-tags-table'
import { annotatePackageFlow } from './capture-annotate-package'
import { fieldsPackageFlow } from './capture-fields-package'
import { prepareFullFeatureCapture } from './capture-settings'
import { pluginSettingsFlow } from './capture-plugin-settings'
import { musicFlow } from './capture-music'
import { inspectorLayoutFlow } from './capture-inspector'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function captureDir(): string | undefined {
  return process.env.CAPTURE_DIR
}

/**
 * 在工具栏的"显示"面板里做一件事（截图流程用）：打开面板，对面板执行 body，再关上。
 * body 是一段 JS 函数的源码，参数是面板元素。
 */
function displayJs(pane: string, body: string): string {
  return `(async () => {
    const btn = ${pane}.querySelector('.display-menu > button');
    if (!${pane}.querySelector('.display-panel')) btn.click();
    await new Promise((r) => setTimeout(r, 60));
    const result = (${body})(${pane}.querySelector('.display-panel'));
    await new Promise((r) => setTimeout(r, 60));
    if (${pane}.querySelector('.display-panel')) btn.click();
    return result;
  })()`
}
const LAYOUT_TITLES: Record<string, string> = { masonry: '瀑布流', kanban: '看板', table: '表格' }
/** 换布局。 */
const setLayoutJs = (pane: string, id: string) =>
  displayJs(pane, `(panel) => { const b = [...panel.querySelectorAll('.segmented button')].find((x) => x.textContent === ${JSON.stringify(LAYOUT_TITLES[id])}); b?.click(); return !!b }`)
/** 布局自己的选项（例如看板按什么分列）：按选项的值或显示的字选。返回全部选项的字。 */
const setOptionJs = (pane: string, by: { value?: string; text?: string }) =>
  displayJs(
    pane,
    `(panel) => {
      const sel = panel.querySelector('select');
      if (!sel) return null;
      const opt = [...sel.options].find((o) => ${JSON.stringify(by.value ?? null)} !== null ? o.value === ${JSON.stringify(by.value ?? null)} : o.textContent === ${JSON.stringify(by.text ?? null)});
      if (opt) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      return [...sel.options].map((o) => o.textContent);
    }`
  )
/** 现在的布局（"显示"按钮上写着）。 */
const layoutNowJs = (pane: string) => `${pane}.querySelector('.display-menu > button')?.textContent.replace(' ▾', '')`

/** 右键菜单的一项（页面发来的）。 */
export type ContextItem = { type: 'separator' } | { id: string; label: string; accelerator?: string }

/** 截图模式下的右键菜单：系统菜单截不到，记下弹出了什么，按流程事先选好的那一项（按字）回答。 */
let menuChoice: string | readonly string[] | undefined
let lastMenu: ContextItem[] = []
export function chooseCaptureMenu(label: string) { menuChoice = label }
export function captureContextMenu(items: ContextItem[]): string | null {
  lastMenu = items
  const [choice, ...remaining] = typeof menuChoice === 'string' ? [menuChoice] : menuChoice ?? []
  menuChoice = remaining.length ? remaining : undefined
  const hit = items.find((i) => 'id' in i && i.label.startsWith(choice ?? '\0'))
  return hit && 'id' in hit ? hit.id : null
}
const menuText = (items: ContextItem[]) => items.map((i) => ('id' in i ? i.label + (i.accelerator ? `（${i.accelerator}）` : '') : '———'))

export async function runCapture(win: BrowserWindow, dir: string): Promise<void> {
  const shot = async (name: string) => {
    await compareStyles(win, dir, name)
    const img = await win.webContents.capturePage()
    writeFileSync(join(dir, name), img.toPNG())
  }
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const log = (label: string, value: unknown) => console.log(`[capture] ${label}`, JSON.stringify(value))
  const key = (k: string, mods = '') =>
    js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, metaKey: ${mods.includes('meta')}, bubbles: true }))`)
  /** 点击文字以 text 开头的元素（在 selector 范围内）。 */
  const click = (selector: string, text: string) =>
    js(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
      el?.click();
      return !!el;
    })()`)
  const tabs = () =>
    js(`[...document.querySelectorAll('.tab')].map((t) => (t.classList.contains('active') ? '*' : '') + t.querySelector('.tab-title').textContent)`)
  const scrollTop = () => js(`document.querySelector('.tab-pane:not(.hidden) .grid-scroller')?.scrollTop ?? -1`)

  try {
    if (process.env.CAPTURE_FLOW === 'studio-extensions') { await studioExtensionsFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'provider-engines') { await providerEnginesFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'comic-reads') { await comicReadsFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'media-editions') { await mediaEditionsFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'shared-runtimes') { await sharedRuntimesFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'native-engines') { await nativeEnginesFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'media-heavy') { await mediaHeavyFlow(dir); return }
    if (process.env.CAPTURE_FLOW === 'media-capabilities') { await mediaCapabilitiesFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'performance') { await performanceFlow(win, dir); return }
    await wait(3000)
    if (process.env.CAPTURE_FLOW === 'workbenchservices') { await workbenchServicesFlow(win, dir, { js, shot }); return }
    if (['packageinstall', 'packageinstallresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await packageInstallFlow(win, dir, { js, shot }); return }
    if (['pluginsuites', 'pluginsuitesresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await pluginSuitesFlow(win, dir, { js, shot }); return }
    if (['pluginpresets', 'pluginpresetsother', 'pluginpresetsresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await pluginPresetsFlow(win, dir, { js, shot }); return }
    if ((process.env.CAPTURE_FLOW ?? '').startsWith('workbenchpreset')) { await workbenchPresetsFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (['browsinglayout', 'browsinglayoutmissing', 'browsinglayoutresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await browsingLayoutFlow(win, dir, label => { menuChoice = label }); return }
    if (['collectionsurface', 'collectionsurfaceresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await collectionSurfaceFlow(win, dir); return }
    if (['openwith', 'openwithresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await openWithFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if ((process.env.CAPTURE_FLOW ?? '').startsWith('tagplugins')) { await tagPluginsFlow(win, dir, { js, shot }); return }
    if (process.env.CAPTURE_FLOW === 'inspector') { await inspectorFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (process.env.CAPTURE_FLOW === 'playback') { await playbackFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'palette') { await paletteFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'plugininput') { await pluginInputFlow(win, dir, label => { menuChoice = label }); return }
    if (['theme-libraries', 'theme-libraries-resume', 'theme-decoration', 'theme-composition', 'theme-cycle', 'theme-cycle-resume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await libraryThemesFlow(win, dir, label => { menuChoice = label }); return
    }
    if (process.env.CAPTURE_FLOW === 'theme-readers') { await themeReadersFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'theme-parts') { await themePartsFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'theme') { await themeFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'uikit') { await uiKitFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'contentwindow') { await contentWindowFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'plugindata') { await pluginDataFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'settingswindow') { await settingsWindowFlow(win, dir); return }
    if (['queryviews', 'queryviewsresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await queryViewsFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (['sharedediting', 'sharededitingresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await sharedEditingFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (['pageinstances', 'pageinstancesresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await pageInstancesFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (['pagelifecycle', 'pagelifecycleresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await pageLifecycleFlow(win, dir, { js, shot }); return }
    if (['editorlayout', 'editorlayoutresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await editorLayoutFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label }, readMenu: () => lastMenu }); return }
    if (['contexttools', 'contexttoolsresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await contextToolsFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (['tabletools', 'tabletoolsresume', 'tabletoolsfaults'].includes(process.env.CAPTURE_FLOW ?? '')) { await tablePluginsFlow(win, dir, { js, log, shot, click, chooseMenu: label => { menuChoice = label } }); return }
    if (['uiextensions', 'uiextensionsmissing', 'uiextensionsresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await uiExtensionsFlow(win, dir, { js, shot }); return }
    if (['sidebarlayout', 'sidebarlayoutresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await sidebarLayoutFlow(win, dir, { js, shot, chooseMenu: label => { menuChoice = label } }); return }
    if (['developmentdirectory', 'developmentdirectoryresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await developmentDirectoryFlow(win, dir); return }
    if (['itemdisposal', 'itemdisposalresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await itemDisposalFlow(win, dir, label => { menuChoice = label }); return }
    if (['fileediting', 'fileeditingdisabled', 'fileeditinguninstalled', 'fileeditingresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await fileEditingFlow(win, dir, label => { menuChoice = label }); return }
    if (process.env.CAPTURE_FLOW === 'sourcemcp') { await sourceMcpFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'spaceitems') { await spaceItemsFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'directorymaintenance') { await directoryMaintenanceFlow(win, dir); return }
    if (['directoryspace', 'directoryspaceresume', 'directoryspaceidentity', 'directorycollection', 'directorycollectionresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await directorySpaceFlow(win, dir); return }
    if (['spacedisk', 'spacediskresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await spaceDiskFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'spacerefresh') { await spaceRefreshFlow(win, dir); return }
    if (['spacedisposal', 'spacedisposalresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await spaceDisposalFlow(win, dir); return }
    if (['spaceforget', 'spaceforgetresume'].includes(process.env.CAPTURE_FLOW ?? '')) { await fileSpaceForgetFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'fileedits') { await fileEditsFlow(win, dir, { choose: label => { menuChoice = label }, labels: () => lastMenu.flatMap(i => 'label' in i ? [i.label] : []) }); return }
    if (process.env.CAPTURE_FLOW === 'versionlifecycle') { await versionLifecycleFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'spaceupdates') { await fileUpdatesFlow(win, dir); return }
    if (process.env.CAPTURE_FLOW === 'spaceversions') {
      await spaceVersionsFlow(win, dir)
      return
    }
    if (['inspectlayout', 'pluginsettings', 'datacore', 'uiapi', 'tableplugins', 'management', 'searchscope', 'create', 'pdfnotes', 'annotate', 'highlight', 'segment', 'structure', 'attach', 'fields', 'kanban', 'toolbar', 'export', 'purge'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await prepareFullFeatureCapture(win)
      await wait(500)
    }
    await shot('1-grid.png')
    log('标签页', await tabs())
    if (process.env.CAPTURE_FLOW === 'queries') {
      await queriesFlow(win, dir)
      return
    }
    if (process.env.CAPTURE_FLOW === 'transfer') {
      await transferFlow(win, dir, { js, log, shot })
      return
    }
    if (['inspectlayout', 'inspectlayoutresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await inspectorLayoutFlow(win, dir, { js, log, shot, chooseMenu: label => { menuChoice = label } })
      return
    }
    if (['audiocover', 'audiocoverresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await audioCoverFlow(win, dir, { js, log, shot })
      return
    }
    if (['music', 'musicresume', 'lyricmatch', 'lyricmatchresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await musicFlow(win, dir, { js, log, shot, chooseMenu: label => { menuChoice = label } })
      return
    }
    if (['tagstable', 'tagstableresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await tagsTableFlow(win, dir, { js, log, shot })
      return
    }
    if (['annotatepackage', 'annotatepackageresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await annotatePackageFlow(win, dir, { js, log, shot })
      return
    }
    if (['fieldspackage', 'fieldspackageresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await fieldsPackageFlow(win, dir, { js, log, shot })
      return
    }
    if (['plugindefaults', 'plugindefaultsresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await pluginDefaultsFlow(win, dir, { js, log, shot })
      return
    }
    if (process.env.CAPTURE_FLOW === 'pluginsettings') {
      await pluginSettingsFlow(win, dir, { js, log, shot })
      return
    }
    if (['packagedbuiltins', 'packagedbuiltinsresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await packagedBuiltinsFlow(win, dir, { js, log, shot })
      return
    }
    if (['packages', 'packagesresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await packagesFlow(win, dir, { js, log, shot })
      return
    }
    if (process.env.CAPTURE_FLOW === 'audio' || process.env.CAPTURE_FLOW === 'audioresume') {
      await audioFlow(win, dir, { js, log, shot })
      return
    }
    if (['management', 'managementlegacy'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await managementFlow(win, dir, { js, log, shot, chooseMenu: label => { menuChoice = label } })
      return
    }
    if (process.env.CAPTURE_FLOW === 'datacore') {
      await dataCoreFlow(win, dir, { js, log, shot })
      return
    }
    if (process.env.CAPTURE_FLOW === 'uiapi') {
      await uiApiFlow(win, dir, { js, log, shot })
      return
    }
    if (process.env.CAPTURE_FLOW === 'tableplugins') {
      await tablePluginsFlow(win, dir, { js, log, shot, click, chooseMenu: label => { menuChoice = label } })
      return
    }
    if (['mcpcreate', 'mcpcreateresume'].includes(process.env.CAPTURE_FLOW ?? '')) {
      await mcpCreateFlow(win, dir, { js, log, shot, click })
      return
    }
    if (process.env.CAPTURE_FLOW === 'searchscope') {
      await scopedSearchFlow(win, dir, { js, log, shot, click })
      return
    }
    if (process.env.CAPTURE_FLOW === 'restore') {
      log('开着的仓库窗口', BrowserWindow.getAllWindows().map((w) => w.getTitle()))
      log('当前标签页滚动位置', await scrollTop())
      log('播放器', await js(`(() => { const v = document.querySelector('.tab-pane:not(.hidden) .player-video'); return v ? { paused: v.paused, currentTime: Math.round(v.currentTime * 10) / 10 } : null })()`))
      return
    }
    if (process.env.CAPTURE_FLOW === 'drag') {
      await dragFlow(win, dir, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'player') {
      await playerFlow({ js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'annotate') {
      await annotateFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'toolbar') {
      await toolbarFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'panels') {
      await panelsFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'masonry') {
      await masonryFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'create') {
      await createFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'taggroups') {
      await tagGroupsFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'pdfnotes' || process.env.CAPTURE_FLOW === 'pdfresume') {
      await pdfNotesFlow(win, dir, { js, log, shot, click, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'pdfdrop') {
      await pdfDropFlow(win, dir, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'rename') {
      await renameFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'purge') {
      await purgeFlow(win, dir, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'export') {
      await exportFlow(win, dir, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'pdf') {
      await pdfFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'highlight') {
      await highlightFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'links') {
      await linksFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'search') {
      await searchFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'text') {
      await textFlow(win, { js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'segment') {
      await segmentFlow({ js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'plugins') {
      await pluginsFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'structure') {
      await structureFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'attach') {
      await attachFlow({ js, log, shot, click, tabs, key })
      return
    }
    if (process.env.CAPTURE_FLOW === 'fields') {
      await fieldsFlow(win, { js, log, shot, click, tabs })
      return
    }
    if (process.env.CAPTURE_FLOW === 'kanban') {
      await kanbanFlow(win, { js, log, shot, click })
      return
    }

    // 按名字选中一张卡片（默认第 1 张），看检查器
    await js(`(() => {
      const name = ${JSON.stringify(process.env.CAPTURE_PICK_NAME ?? '')};
      const cards = [...document.querySelectorAll('.tab-pane:not(.hidden) .card')];
      const card = cards.find((c) => name && c.querySelector('.card-caption').textContent.includes(name)) ?? cards[0];
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    })()`)
    await wait(1200)
    await shot('2-inspector.png')

    // 在检查器里设状态：卡片上出现状态角标，侧栏出现"状态"分面
    if (await click('.status-option', '进行中')) {
      await wait(1000)
      log('设为进行中', {
        badges: await js(`[...document.querySelectorAll('.tab-pane:not(.hidden) .card.selected .badge')].map((b) => b.textContent)`),
        facet: await js(`[...document.querySelectorAll('.sidebar .nav-title')].map((t) => t.textContent)`)
      })
      await shot('2b-status.png')
    }

    await key(' ')
    await wait(1200)
    await shot('3-preview.png')

    // 预览里是视频时：检查能否拖动进度（字节区间读取），以及空格是播放 / 暂停而不是关闭
    const video = await js(`new Promise((res) => {
      const v = document.querySelector('.preview video');
      if (!v) return res(null);
      const go = () => { v.pause(); const target = v.duration * 0.7; v.onseeked = () => res({ duration: v.duration, target, currentTime: v.currentTime, size: [v.videoWidth, v.videoHeight] }); v.currentTime = target; };
      v.readyState >= 1 ? go() : v.addEventListener('loadedmetadata', go, { once: true });
      setTimeout(() => res({ timeout: true, readyState: v.readyState, error: v.error && v.error.code }), 15000);
    })`)
    if (video) {
      log('视频', video)
      await wait(500)
      await shot('5-video-seeked.png')
      await key(' ')
      await wait(300)
      log('预览里按空格', await js(`(() => { const v = document.querySelector('.preview video'); return v ? { previewOpen: true, paused: v.paused } : { previewOpen: false } })()`))
    }
    await key('Escape')
    await wait(300)

    // 滚动网格：检查滚动与虚拟化
    log(
      '滚动后',
      await js(`(() => {
        const el = document.querySelector('.tab-pane:not(.hidden) .grid-scroller');
        el.scrollTop = 1500;
        return { scrollTop: el.scrollTop, cards: el.querySelectorAll('.card').length };
      })()`)
    )
    await wait(800)
    await shot('4-scrolled.png')
    const firstScroll = await scrollTop()

    // 标签页：新建 → 从侧栏打开"视频"视图 → 按格式筛选 → 另存为视图
    win.webContents.send('menu:command', 'tab.new')
    await wait(800)
    log('点侧栏「视频」', await click('.sidebar .nav-item', '视频'))
    await wait(1200)
    log('标签页', await tabs())
    await shot('6-tab-videos.png')

    log('点分面「mp4」', await click('.sidebar .nav-item', 'mp4'))
    await wait(600)
    log('点「另存为视图」', await click('.toolbar button', '另存为视图'))
    await wait(200)
    await js(`(() => {
      const input = document.querySelector('.name-input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, 'MP4 视频');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await wait(100)
    await js(`document.querySelector('.name-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await wait(1500)
    log('侧栏视图', await js(`[...document.querySelectorAll('.sidebar .nav-group')[0].querySelectorAll('.nav-label')].map((e) => e.textContent)`))
    log('标签页', await tabs())
    await shot('7-saved-view.png')

    // 切回第一个标签页：滚动位置应当还在
    await key('1', 'meta')
    await wait(800)
    log('切回第一个标签页', { before: firstScroll, after: await scrollTop(), tabs: await tabs() })
    await shot('8-back-to-first.png')
    await wait(1000) // 等工作区保存
  } catch (e) {
    console.error('[capture]', e)
  } finally {
    app.quit()
  }
}

interface Tools {
  js(code: string): Promise<any>
  log(label: string, value: unknown): void
  shot(name: string): Promise<void>
  click(selector: string, text: string): Promise<boolean>
  tabs(): Promise<string[]>
}

/**
 * 拖拽流程：卡片 → 标签头（可写视图）。
 * 拖动开始：模拟 dragstart，检查页面请求主进程交出的是不是库里的原文件。
 * 拖入放下：用调试协议 Input.dispatchDragEvent 把带文件路径的拖入投递到标签头的坐标上。
 * 中间系统拖拽会话（macOS 把文件带过来）只能手动验证。
 */
async function dragFlow(win: BrowserWindow, dir: string, { js, log, shot, click, tabs }: Tools): Promise<void> {
  const tagCount = () =>
    js(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find((e) => e.querySelector('.nav-count') && e.querySelector('.nav-label').textContent === '配色'); return b ? Number(b.querySelector('.nav-count').textContent) : -1 })()`)
  const count = () => js(`document.querySelector('.tab-pane:not(.hidden) .toolbar-count')?.textContent`)

  // 1. 建一个可写视图：按"配色"标签筛选，另存为"配色合集"；再开一个"全部"
  log('点分面「配色」', await click('.sidebar .nav-item', '配色'))
  await wait(500)
  await click('.toolbar button', '另存为视图')
  await wait(200)
  await js(`(() => {
    const input = document.querySelector('.name-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '配色合集');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(1000)
  win.webContents.send('menu:command', 'tab.new')
  await wait(1200)
  log('标签页', await tabs())
  const before = { tag: await tagCount() }

  // 2. 拖动开始：在"会议记录.txt"卡片上触发 dragstart，截获交给主进程的请求
  const requested = new Promise<{ file: string; icon?: string }>((resolve) =>
    ipcMain.once('drag:start', (_e, req: { files: string[]; icon?: string }) => resolve({ file: req.files[0], icon: req.icon }))
  )
  const started = await js(`(() => {
    const card = [...document.querySelectorAll('.tab-pane:not(.hidden) .card')].find((c) => c.querySelector('.card-caption').textContent.includes('会议记录'));
    if (!card) return false;
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
    return true;
  })()`)
  const req = await Promise.race([requested, wait(3000).then(() => undefined)])
  log('拖动开始', { started, file: req?.file, icon: req?.icon })
  if (!req) return

  // 3. 放下：把同一个文件投递到"配色合集"标签头上
  const rect = await js(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('配色合集'));
    const r = tab.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const drag = (type: string, x: number, y: number, files: string[]) =>
    dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data: { items: [], files, dragOperationsMask: 1 } })
  await drag('dragEnter', rect.x, rect.y, [req.file])
  await drag('dragOver', rect.x, rect.y, [req.file])
  await wait(200)
  log('拖到标签头上', { highlighted: await js(`!!document.querySelector('.tab.drop')`) })
  await shot('d1-drag-over-tab.png')
  await drag('drop', rect.x, rect.y, [req.file])
  await wait(1200)
  log('放下后', { toast: await js(`document.querySelector('.toast')?.textContent`), tag: { before: before.tag, after: await tagCount() } })
  await shot('d2-dropped.png')

  // 3b. 拖到"视频"视图的标签头上：文本文件不满足"有视频"，应被拒绝并说明原因
  await js(`[...document.querySelectorAll('.sidebar .nav-item')].find((e) => e.textContent.trim() === '视频')?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))`)
  await wait(800)
  log('⌘ 点「视频」开新标签页', await tabs())
  const videoTab = await js(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('视频'));
    const r = tab.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  await drag('dragEnter', videoTab.x, videoTab.y, [req.file])
  await drag('dragOver', videoTab.x, videoTab.y, [req.file])
  await drag('drop', videoTab.x, videoTab.y, [req.file])
  await wait(1200)
  log('拖到「视频」标签头', { toast: await js(`document.querySelector('.toast')?.textContent`) })
  await shot('d2b-rejected.png')

  // 4. 从外面拖进一个新文件，放在"配色合集"标签页的内容区：收录的同时打上标签
  // 标签头按下鼠标即切换（不是 click）
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('配色合集'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await wait(1000)
  log('切到「配色合集」', { tabs: await tabs(), count: await count() })
  const countBefore = await count()
  const external = join(dir, `外部文件-${Date.now()}.txt`)
  writeFileSync(external, `从访达拖进来的文件 ${Date.now()}`)
  const center = await js(`(() => { const r = document.querySelector('.tab-pane:not(.hidden) .grid-scroller').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await drag('dragEnter', center.x, center.y, [external])
  await drag('dragOver', center.x, center.y, [external])
  await drag('drop', center.x, center.y, [external])
  await wait(1500)
  log('外部文件拖进可写视图', {
    count: { before: countBefore, after: await count() },
    cards: await js(`[...document.querySelectorAll('.tab-pane:not(.hidden) .card-caption')].map((c) => c.textContent).filter((t) => t.includes('会议记录') || t.includes('外部文件'))`)
  })
  await shot('d3-external-into-view.png')
  dbg.detach()
}

/**
 * 看板流程：切换布局 → 按状态分列 → 拖卡片换列（有文件的走系统拖拽交出的文件路径，
 * 文字走窗口内拖动带的身份）→ 拖回"未设置" → 按只读字段分列时拖动被拒绝 → 另存为视图。
 */
async function kanbanFlow(win: BrowserWindow, { js, log, shot, click }: Omit<Tools, 'tabs'>): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  /** title 是"布局"时换布局；空的是布局自己的选项（看板按什么分列）。 */
  const select = (title: string, value: string) => js(title === '布局' ? setLayoutJs(pane, value) : setOptionJs(pane, { value }))
  const columns = () =>
    js(`[...${pane}.querySelectorAll('.kanban-col')].map((c) => c.querySelector('.kanban-title').textContent + ' ' + c.querySelector('.kanban-head .muted').textContent)`)
  const columnOf = (name: string) =>
    js(`(() => {
      const col = [...${pane}.querySelectorAll('.kanban-col')].find((c) => [...c.querySelectorAll('.card-caption')].some((e) => e.textContent.includes(${JSON.stringify(name)})));
      return col ? col.querySelector('.kanban-title').textContent : null;
    })()`)
  const columnPoint = (title: string) =>
    js(`(() => {
      const col = [...${pane}.querySelectorAll('.kanban-col')].find((c) => c.querySelector('.kanban-title').textContent === ${JSON.stringify(title)});
      const r = col.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 200)) };
    })()`)
  // 在卡片上触发 dragstart：有文件时页面请求主进程交出文件，否则把身份写进 dataTransfer
  const startDrag = async (name: string): Promise<{ files?: string[]; ids?: string[] }> => {
    let listener: (e: unknown, req: { files: string[] }) => void = () => {}
    const requested = new Promise<{ files: string[] }>((resolve) => {
      listener = (_e, req) => resolve(req)
      ipcMain.once('drag:start', listener)
    })
    const ids = await js(`(() => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes(${JSON.stringify(name)}));
      card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const data = dt.getData('application/x-rm-entities');
      return data ? JSON.parse(data) : null;
    })()`)
    if (ids) {
      ipcMain.removeListener('drag:start', listener)
      return { ids }
    }
    const req = await Promise.race([requested, wait(3000).then(() => undefined)])
    return { files: req?.files }
  }
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const drop = async (payload: { files?: string[]; ids?: string[] }, column: string, shotName?: string) => {
    const p = await columnPoint(column)
    const data = payload.ids
      ? { items: [{ mimeType: 'application/x-rm-entities', data: JSON.stringify(payload.ids) }], dragOperationsMask: 1 }
      : { items: [], files: payload.files ?? [], dragOperationsMask: 1 }
    await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: p.x, y: p.y, data })
    await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data })
    await wait(200)
    const highlighted = await js(`${pane}.querySelector('.kanban-col.drop-target .kanban-title')?.textContent ?? null`)
    if (shotName) await shot(shotName)
    await dbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: p.x, y: p.y, data })
    await wait(1200)
    return highlighted
  }
  const toast = () => js(`document.querySelector('.toast')?.textContent ?? null`)

  try {
    // 1. "全部"切到看板：默认按状态分列
    log('切换布局', await select('布局', 'kanban'))
    await wait(1500)
    log('列', await columns())
    await shot('k1-kanban.png')

    // 2. 有文件的卡片：从"未设置"拖到"进行中"
    // 演示库变大以后，"会议记录"排到了列的下面（看不见的不渲染），换成排在上面的 PDF
    const image = '版式手册'
    log('拖动前', { [image]: await columnOf(image) })
    const a = await startDrag(image)
    log('拖动开始', { files: a.files?.length, ids: a.ids?.length })
    const over = await drop(a, '进行中', 'k2-drag-over.png')
    log('拖到「进行中」', { 高亮: over, 现在在: await columnOf(image), toast: await toast(), 列: await columns() })

    // 3. 文字（没有文件）：窗口内拖动，带身份
    const text = '好的设计'
    const b = await startDrag(text)
    log('文字拖动开始', { files: b.files?.length, ids: b.ids?.length })
    await drop(b, '已完成')
    log('文字拖到「已完成」', { 现在在: await columnOf(text), toast: await toast() })
    await shot('k3-moved.png')

    // 4. 拖回"未设置"：状态被清掉
    await drop(await startDrag(text), '未设置')
    log('文字拖回「未设置」', { 现在在: await columnOf(text), 列: await columns() })

    // 5. 按只读字段（动图）分列：拖动被拒绝并说明
    log('改按「动图」分列', await select('', 'image.animated'))
    await wait(1200)
    log('列', await columns())
    await drop(await startDrag(text), '是')
    log('拖到只读列「是」', { toast: await toast(), 现在在: await columnOf(text) })
    await shot('k4-readonly-rejected.png')

    // 6. 改回按状态分列，另存为视图
    await select('', 'status.value')
    await wait(800)
    log('工具栏按钮', await js(`[...${pane}.querySelectorAll('.toolbar button')].map((b) => b.textContent)`))
    await click('.toolbar button', '另存为视图')
    await wait(200)
    await js(`(() => {
      const input = document.querySelector('.name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '任务看板');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    await wait(1200)
    log('另存后', {
      侧栏视图: await js(`[...document.querySelectorAll('.sidebar .nav-group')[0].querySelectorAll('.nav-label')].map((e) => e.textContent)`),
      工具栏按钮: await js(`[...${pane}.querySelectorAll('.toolbar button')].map((b) => b.textContent)`),
      列: await columns()
    })
    await shot('k5-saved.png')
    await wait(1000) // 等工作区保存
  } finally {
    dbg.detach()
  }
}

/**
 * 播放器流程：从"视频"视图双击打开播放器标签页 → 悬停时间轴看预览帧 → 快捷键跳转 →
 * 下一个 → 切走时暂停 → 再次双击同一个视频不新开 → 不能直接播放的视频按需转码后播放。
 */
async function playerFlow({ js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const video = () =>
    js(`(() => {
      const v = ${pane}.querySelector('.player-video');
      return v ? { paused: v.paused, t: Math.round(v.currentTime * 10) / 10, duration: Math.round(v.duration * 10) / 10 } : null;
    })()`)
  const openCard = (name: string) =>
    js(`(() => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes(${JSON.stringify(name)}));
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return !!card;
    })()`)

  log('点侧栏「视频」', await click('.sidebar .nav-item', '视频'))
  await wait(1500)
  log('双击「分形」', await openCard('分形'))
  await wait(2500)
  log('标签页', await tabs())
  log('播放中', await video())
  log('控制条', await js(`${pane}.querySelector('.player-title')?.textContent`))
  log('检查器', await js(`document.querySelector('.inspector')?.textContent.slice(0, 60)`))
  await shot('p1-player.png')

  // 悬停时间轴 60% 处：显示预览帧和时间
  const hover = await js(`(() => {
    const bar = ${pane}.querySelector('.timeline');
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * 0.6, clientY: r.top + r.height / 2, pointerId: 1 }));
    return true;
  })()`)
  await wait(400)
  log('悬停时间轴', {
    hover,
    frame: await js(`(() => { const f = ${pane}.querySelector('.timeline-frame'); return f ? { pos: f.style.backgroundPosition, w: f.style.width, h: f.style.height } : null })()`),
    time: await js(`${pane}.querySelector('.timeline-hover span')?.textContent`)
  })
  await shot('p2-hover.png')

  // 快捷键：空格暂停，→ 前进 5 秒，5 跳到 50%
  await key(' ')
  await wait(300)
  const before = await video()
  await key('ArrowRight')
  await wait(400)
  const after = await video()
  await key('5')
  await wait(400)
  log('快捷键', { 暂停后: before, 右方向键: after, 按5: await video() })

  // 上一个 / 下一个：在打开它的"视频"列表里（"分形"是最后一个）
  const title = () => js(`${pane}.querySelector('.player-title')?.textContent`)
  await key('p')
  await wait(2000)
  log('按 P', { tabs: await tabs(), video: await video(), title: await title() })
  await shot('p3-prev.png')
  await key('n')
  await wait(1500)
  log('按 N', { tabs: await tabs(), title: await title() })
  log('分形的播放进度', await js(`document.querySelector('.inspector')?.textContent.match(/上次看到 [0-9:]+|已看完/)?.[0] ?? null`))

  // 切到第一个标签页：播放器暂停
  await key('1', 'meta')
  await wait(600)
  log('切走后', {
    tabs: await tabs(),
    隐藏的播放器: await js(`(() => { const v = document.querySelector('.tab-pane.hidden .player-video'); return v ? { paused: v.paused } : null })()`)
  })

  // 再次双击正在播放器里的那个视频：切过去，不新开
  const current = (await tabs()).find((t: string) => !t.startsWith('*') && t !== '视频')
  log('再次双击', { 视频: current, ok: await openCard(String(current).replace(/\.[a-z0-9]+$/, '')) })
  await wait(1200)
  log('标签页', await tabs())

  // 不能直接播放的视频：按需转码后播放
  await key('1', 'meta')
  await wait(600)
  log('双击「旧格式」', await openCard('旧格式'))
  await wait(400)
  log('转码中', await js(`${pane}.querySelector('.player-status')?.textContent ?? null`))
  await shot('p4-transcoding.png')
  for (let i = 0; i < 30 && !(await video()); i++) await wait(500)
  await wait(1500)
  log('转码后', { tabs: await tabs(), video: await video() })
  await shot('p5-avi.png')
  await wait(1000) // 等工作区保存
}

/**
 * 自定义字段流程（设计文档 11.4）：侧栏新建模板 → 表头新建字段 → 把视频拖进模板的表（挂上空模板）→
 * 在格子里填单选（新建选项）、评分、文本、复选框 → 检查器 → 看板按模板的单选分列 → 侧栏分面。
 */
async function fieldsFlow(win: BrowserWindow, { js, log, shot, tabs }: Tools): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const setInput = (selector: string, value: string, enter = true) =>
    js(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ${enter ? `input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));` : ''}
      return true;
    })()`)
  const rows = () =>
    js(`[...${pane}.querySelectorAll('.table-row')].map((r) => [...r.querySelectorAll('.td')].map((c) =>
      c.querySelector('.rating') ? '★' + c.querySelectorAll('.star.on').length :
      c.querySelector('input[type=checkbox]') ? (c.querySelector('input[type=checkbox]').checked ? '☑' : '☐') :
      c.textContent.trim()))`)
  const header = () => js(`[...${pane}.querySelectorAll('.table-head .th')].map((t) => t.textContent.trim())`)
  /** 点第 row 行第 col 个字段的格子（第 0 列是素材）。 */
  const clickCell = (row: number, col: number) =>
    js(`(() => { const td = ${pane}.querySelectorAll('.table-row')[${row}].querySelectorAll('.td')[${col}]; td.click(); return true })()`)

  // 1. 侧栏新建模板：打开它的表
  await js(`document.querySelector('.sidebar .nav-add').click()`)
  await wait(200)
  await js(`[...document.querySelectorAll('.nav-menu .nav-item')].find((b) => b.textContent === '新建模板').click()`)
  await wait(300)
  await setInput('.nav-input', '影视片段')
  await wait(1500)
  log('新建模板', { tabs: await tabs(), layout: await js(layoutNowJs(pane)), header: await header() })
  await shot('f1-empty-table.png')

  // 2. 表头＋新建字段
  for (const [title, type] of [
    ['镜头', '单选'],
    ['评分', '评分'],
    ['片名', '文本'],
    ['看过', '复选框']
  ]) {
    await js(`${pane}.querySelector('.th.add [aria-label="新建字段"]').click()`)
    await wait(300)
    await setInput('.add-field input', title, false)
    await js(`[...document.querySelectorAll('.add-field button[aria-pressed]')].find((b) => b.textContent === ${JSON.stringify(type)}).click()`)
    await wait(100)
    await js(`document.querySelector('.add-field button[type="submit"]').click()`)
    await wait(700)
  }
  log('新建字段后', { header: await header(), facets: await js(`[...document.querySelectorAll('.sidebar .nav-title')].map((t) => t.textContent)`) })

  // 3. 把三个 mp4 拖进这个表：挂上空模板
  const root = process.env.LIBRARY_PATH!
  const videos = readdirSync(join(root, 'files'))
    .flatMap((id) => readdirSync(join(root, 'files', id)).map((f) => join(root, 'files', id, f)))
    .filter((f) => f.endsWith('.mp4'))
  const p = await js(`(() => { const r = ${pane}.querySelector('.table-scroller').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await dbg.sendCommand('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data: { items: [], files: videos, dragOperationsMask: 1 } })
  }
  dbg.detach()
  await wait(1500)
  log('拖进三个视频', { toast: await js(`document.querySelector('.toast')?.textContent ?? null`), rows: await rows() })

  // 4. 填第一行：单选（新建选项"推"）、评分、片名、复选框
  await clickCell(0, 1)
  await wait(300)
  await js(`document.querySelector('.cell-popover .field-option.add').click()`)
  await wait(200)
  await setInput('.cell-popover .option-input', '推')
  await wait(800)
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await wait(200)
  await js(`${pane}.querySelectorAll('.table-row')[0].querySelectorAll('.td')[2].querySelectorAll('.star')[3].click()`)
  await wait(300)
  await clickCell(0, 3)
  await wait(300)
  await setInput('.cell-inline input', '花样年华')
  await wait(300)
  await js(`${pane}.querySelectorAll('.table-row')[0].querySelector('input[type=checkbox]').click()`)
  await wait(800)
  // 第二行选"推"（已有选项）
  await clickCell(1, 1)
  await wait(300)
  await js(`[...document.querySelectorAll('.cell-popover .field-option')].find((b) => b.textContent === '推')?.click()`)
  await wait(800)
  log('填格子后', { rows: await rows() })
  await shot('f2-filled.png')

  // 5. 选中第一行：检查器里是模板分区，按字段类型的编辑器
  await js(`${pane}.querySelectorAll('.table-row')[0].querySelector('.td.first').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await wait(800)
  log('检查器', await js(`(() => {
    const b = document.querySelector('.inspector .template-block');
    if (!b) return null;
    return { 模板: b.querySelector('.template-head').textContent, 字段: [...b.querySelectorAll('.prop-row')].map((r) => r.querySelector('dt').textContent + '=' + (r.querySelector('.field-option.active')?.textContent ?? (r.querySelector('.rating') ? '★' + r.querySelectorAll('.star.on').length : r.querySelector('input[type=checkbox]') ? String(r.querySelector('input[type=checkbox]').checked) : r.querySelector('input')?.value ?? ''))) };
  })()`))
  await shot('f3-inspector.png')

  // 6. 看板：按模板的"镜头"分列
  await js(setLayoutJs(pane, 'kanban'))
  await wait(800)
  const groupBy = await js(setOptionJs(pane, { text: '镜头' }))
  await wait(1200)
  log('看板按镜头分列', {
    可分列字段: groupBy,
    列: await js(`[...${pane}.querySelectorAll('.kanban-col')].map((c) => c.querySelector('.kanban-title').textContent + ' ' + c.querySelector('.kanban-head .muted').textContent)`),
    侧栏分面: await js(`[...document.querySelectorAll('.sidebar .nav-group')].map((g) => g.querySelector('.nav-title')?.textContent + ': ' + [...g.querySelectorAll('.nav-label')].map((l) => l.textContent).join('/'))`)
  })
  await shot('f4-kanban.png')
  await wait(1000)
}

/**
 * 快速附加流程（设计文档 11.5）：选中两张卡片按 A → 状态、新标签 → 存一个带写入条件的视图当配方 →
 * 对另一张卡片"放入配方" → 新建模板和字段后，挂模板、填字段。
 */
async function attachFlow({ js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const select = (names: string[]) =>
    js(`(() => {
      const names = ${JSON.stringify(names)};
      const cards = [...${pane}.querySelectorAll('.card')];
      names.forEach((n, i) => {
        const card = cards.find((c) => c.querySelector('.card-caption').textContent.includes(n));
        card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: i > 0 }));
      });
      return [...${pane}.querySelectorAll('.card.selected .card-caption')].map((c) => c.textContent);
    })()`)
  const type = (text: string) =>
    js(`(() => {
      const input = document.querySelector('.qa-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
  const suggestions = () => js(`[...document.querySelectorAll('.qa-list li')].map((li) => li.querySelector('.qa-label').textContent + ' · ' + li.querySelector('.muted').textContent)`)
  const enter = () => js(`document.querySelector('.qa-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  const qaLog = () => js(`[...document.querySelectorAll('.qa-log div')].map((d) => d.textContent)`)
  const badges = (names: string[]) =>
    js(`Object.fromEntries(${JSON.stringify(names)}.map((n) => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes(n));
      return [n, [...card.querySelectorAll('.badge')].map((b) => b.textContent)];
    }))`)
  const attach = async (text: string, label: string) => {
    await type(text)
    await wait(300)
    const list = await suggestions()
    await enter()
    await wait(900)
    log(label, { 输入: text, 建议: list.slice(0, 4), 结果: (await qaLog()).slice(-1)[0] })
  }

  // 1. 选中两张卡片，按 A
  log('选中', await select(['作品_24', '作品_23']))
  await wait(300)
  await key('a')
  await wait(800)
  log('打开快速附加', { 标题: await js(`document.querySelector('.qa-head')?.textContent`), 默认建议: await suggestions() })
  await shot('a1-open.png')

  await attach('进行', '状态')
  await attach('待剪辑', '新标签')
  await shot('a2-attached.png')
  await key('Escape')
  await js(`document.querySelector('.qa-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(500)
  log('关闭后卡片角标', await badges(['作品_24', '作品_23']))

  // 2. 配方：按"待剪辑"筛选 + 状态"待处理"，另存为视图"待剪片段"
  await click('.sidebar .nav-item', '待剪辑')
  await wait(400)
  await click('.sidebar .nav-item', '待处理')
  await wait(400)
  await click('.toolbar button', '另存为视图')
  await wait(200)
  await js(`(() => {
    const input = document.querySelector('.name-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '待剪片段');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(1200)
  log('存为视图', await tabs())

  // 3. 回到"全部"，给第三张卡片放入配方
  await click('.sidebar .nav-item', '全部')
  await wait(1200)
  log('选中', await select(['作品_22']))
  await key('a')
  await wait(800)
  await attach('待剪片段', '配方')
  await key('Escape')
  await js(`document.querySelector('.qa-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(500)
  log('放入配方后', await badges(['作品_22']))

  // 4. 模板：新建"影视片段"和一个文本字段，再回到"全部"挂上、填字段
  await js(`document.querySelector('.sidebar .nav-add').click()`)
  await wait(200)
  await js(`[...document.querySelectorAll('.nav-menu .nav-item')].find((b) => b.textContent === '新建模板').click()`)
  await wait(300)
  await js(`(() => {
    const input = document.querySelector('.nav-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '影视片段');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(1200)
  await js(`${pane}.querySelector('.th.add [aria-label="新建字段"]').click()`)
  await wait(300)
  await js(`(() => {
    const input = document.querySelector('.add-field input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '片名');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await js(`document.querySelector('.add-field button[type="submit"]').click()`)
  await wait(900)
  await click('.sidebar .nav-item', '全部')
  await wait(1200)
  log('选中', await select(['作品_21']))
  await key('a')
  await wait(800)
  await attach('影视', '挂模板')
  await attach('片名 花样年华', '填模板字段')
  await shot('a3-template.png')
  await key('Escape')
  await js(`document.querySelector('.qa-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(600)
  log('检查器', await js(`document.querySelector('.inspector .template-block')?.textContent ?? null`))
  await wait(800)
}

/**
 * 结构演变与撤销（设计文档 11.6）：建一个有值的模板表 → 文本改数字（先预演）→ ⌘Z 撤销 →
 * 选项改名 → 删字段再撤销 → 标签升级为模板再撤销。
 */
async function structureFlow(win: BrowserWindow, { js, log, shot, click, tabs }: Tools): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const setInput = (selector: string, value: string, enter = true) =>
    js(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ${enter ? `input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));` : ''}
      return true;
    })()`)
  const header = () => js(`[...${pane}.querySelectorAll('.table-head .th')].map((t) => t.textContent.trim())`)
  const rows = () => js(`[...${pane}.querySelectorAll('.table-row')].map((r) => [...r.querySelectorAll('.td')].slice(1).map((c) => c.textContent.trim()))`)
  const toast = () => js(`document.querySelector('.toast')?.textContent ?? null`)
  const cell = (row: number, col: number) => js(`${pane}.querySelectorAll('.table-row')[${row}].querySelectorAll('.td')[${col}].click()`)
  const menu = (title: string) => js(`[...${pane}.querySelectorAll('.table-head .th-label')].find((b) => b.textContent === ${JSON.stringify(title)}).click()`)
  const menuClick = (text: string) => js(`[...document.querySelectorAll('.field-menu button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`)
  const undo = async () => {
    win.webContents.send('menu:command', 'undo')
    await wait(900)
    return toast()
  }

  // 准备：模板"影视片段"，字段 镜头（单选）、年份（文本），三个视频
  await js(`document.querySelector('.sidebar .nav-add').click()`)
  await wait(200)
  await js(`[...document.querySelectorAll('.nav-menu .nav-item')].find((b) => b.textContent === '新建模板').click()`)
  await wait(200)
  await setInput('.nav-input', '影视片段')
  await wait(1200)
  for (const [title, type] of [
    ['镜头', '单选'],
    ['年份', '文本']
  ]) {
    await js(`${pane}.querySelector('.th.add [aria-label="新建字段"]').click()`)
    await wait(200)
    await setInput('.add-field input', title, false)
    await js(`[...document.querySelectorAll('.add-field button[aria-pressed]')].find((b) => b.textContent === ${JSON.stringify(type)}).click()`)
    await js(`document.querySelector('.add-field button[type="submit"]').click()`)
    await wait(600)
  }
  const root = process.env.LIBRARY_PATH!
  const videos = readdirSync(join(root, 'files'))
    .flatMap((id) => readdirSync(join(root, 'files', id)).map((f) => join(root, 'files', id, f)))
    .filter((f) => f.endsWith('.mp4'))
  const p = await js(`(() => { const r = ${pane}.querySelector('.table-scroller').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await dbg.sendCommand('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data: { items: [], files: videos, dragOperationsMask: 1 } })
  }
  dbg.detach()
  await wait(1500)
  for (const [row, shot, year] of [
    [0, '推', '2000'],
    [1, '跟', '二〇一三']
  ] as const) {
    await cell(row, 1)
    await wait(200)
    await js(`document.querySelector('.cell-popover .field-option.add').click()`)
    await wait(150)
    await setInput('.cell-popover .option-input', shot)
    await wait(700)
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await wait(150)
    await cell(row, 2)
    await wait(200)
    await setInput('.cell-inline input', year)
    await wait(500)
  }
  log('准备好的表', { header: await header(), rows: await rows() })

  // 1. 年份：文本 → 数字，先预演
  await menu('年份')
  await wait(300)
  await menuClick('数字')
  await wait(500)
  log('预演', await js(`document.querySelector('.field-menu .menu-confirm span')?.textContent`))
  await shot('s1-preview.png')
  await menuClick('确认更改')
  await wait(1000)
  log('改成数字后', { toast: await toast(), rows: await rows() })
  log('⌘Z', { toast: await undo(), rows: await rows() })

  // 2. 选项改名：跟 → 跟拍
  await menu('镜头')
  await wait(300)
  await js(`(() => {
    const input = [...document.querySelectorAll('.field-menu .option-row input')].find((i) => i.value === '跟');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '跟拍');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(900)
  log('选项改名后', { options: await js(`[...document.querySelectorAll('.field-menu .option-row input')].map((i) => i.value)`), rows: await rows() })
  await shot('s2-options.png')
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await wait(200)

  // 3. 删字段，再撤销
  await menu('年份')
  await wait(300)
  await menuClick('删除字段')
  await wait(500)
  log('删除预演', await js(`document.querySelector('.field-menu .menu-confirm span')?.textContent`))
  await menuClick('确认删除')
  await wait(1000)
  log('删除后', { toast: await toast(), header: await header() })
  log('⌘Z', { toast: await undo(), header: await header(), rows: await rows() })

  // 4. 标签升级为模板，再撤销
  await js(`document.querySelector('.sidebar .nav-add').click()`)
  await wait(200)
  await js(`[...document.querySelectorAll('.nav-menu .nav-item')].find((b) => b.textContent === '从标签升级…').click()`)
  await wait(500)
  await js(`[...document.querySelectorAll('.nav-menu .nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === '光影').click()`)
  await wait(1500)
  const tagGroup = () =>
    js(`(() => { const g = [...document.querySelectorAll('.sidebar .nav-group')].find((g) => g.querySelector('.nav-title')?.textContent === '标签'); return g ? [...g.querySelectorAll('.nav-label')].map((l) => l.textContent) : null })()`)
  const templateGroup = () =>
    js(`(() => { const g = [...document.querySelectorAll('.sidebar .nav-group')].find((g) => g.querySelector('.nav-title')?.textContent.startsWith('模板')); return [...g.querySelectorAll('.nav-label')].map((l) => l.textContent) })()`)
  log('升级后', { toast: await toast(), tabs: await tabs(), rows: (await rows()).length, 模板: await templateGroup(), 标签: await tagGroup() })
  await shot('s3-promoted.png')
  log('⌘Z', { toast: await undo(), 模板: await templateGroup(), 标签: await tagGroup() })
  await click('.sidebar .nav-item', '全部')
  await wait(1000)
}

/**
 * 仓库管理流程（设计文档 13.5）：从仓库管理新建仓库 → 再建一个（两个窗口）→ 再打开已经开着的只是切过去 →
 * 在有别的文件的文件夹里新建被拒绝。退出时记下开着的仓库，下次启动重新打开（另跑 CAPTURE_FLOW=restore 检查）。
 */
export async function runVaultsCapture(launcher: BrowserWindow, dir: string): Promise<void> {
  const log = (label: string, value: unknown) => console.log(`[capture] ${label}`, JSON.stringify(value))
  const shotOf = async (win: BrowserWindow, name: string) => writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG())
  const parent = join(dir, 'vaults')
  mkdirSync(join(parent, '杂物'), { recursive: true })
  writeFileSync(join(parent, '杂物', '旧照片.jpg'), '')
  const libraryWindows = () => BrowserWindow.getAllWindows().filter((w) => w !== launcherWin && !w.isDestroyed())
  let launcherWin = launcher

  const inLauncher = (code: string) => launcherWin.webContents.executeJavaScript(code)
  const setField = (index: number, value: string) =>
    inLauncher(`(() => {
      const input = document.querySelectorAll('.launcher-card .field-text')[${index}];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  const create = async (name: string) => {
    await inLauncher(`document.querySelector('.launcher-home-actions button.primary').click()`)
    await wait(200)
    await setField(0, name)
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [parent] })) as typeof original
    try {
      await inLauncher(`[...document.querySelectorAll('.launcher-create button')].find(b => b.textContent === '选择位置…').click()`)
      await wait(200)
    } finally { dialog.showOpenDialog = original }
    await wait(200)
    await inLauncher(`document.querySelector('.launcher-create-btn').click()`)
    await wait(3500)
  }
  const reopenLauncher = async () => {
    launcherWin = showLauncher(false)
    await new Promise<void>((r) => (launcherWin.webContents.isLoading() ? launcherWin.webContents.once('did-finish-load', () => r()) : r()))
    await wait(800)
  }
  const recent = () => inLauncher(`[...document.querySelectorAll('.vault-item')].map((v) => v.querySelector('.vault-name').textContent)`)

  try {
    await new Promise<void>((r) => launcherWin.webContents.once('did-finish-load', () => r()))
    await wait(1200)
    log('第一次启动', { 最近: await recent(), 位置默认: await inLauncher(`window.bridge.vaults.list().then(v => v.defaultParent)`) })
    await shotOf(launcherWin, 'v1-launcher.png')

    await create('影视参考')
    const first = libraryWindows()
    log('新建「影视参考」', { 窗口: first.map((w) => w.getTitle()), 仓库管理还开着: !launcherWin.isDestroyed() })
    await wait(1500)
    log('侧栏底部', await first[0].webContents.executeJavaScript(`document.querySelector('.vault-switch')?.textContent`))
    await shotOf(first[0], 'v2-vault.png')

    await reopenLauncher()
    log('再打开仓库管理', await recent())
    await create('图片灵感')
    log('新建「图片灵感」', { 窗口: libraryWindows().map((w) => w.getTitle()) })

    await reopenLauncher()
    await inLauncher(`[...document.querySelectorAll('.vault-item')].find((v) => v.querySelector('.vault-name').textContent.startsWith('影视参考')).querySelector('.vault-open').click()`)
    await wait(1500)
    log('点最近里已经开着的「影视参考」', { 窗口: libraryWindows().map((w) => w.getTitle()) })

    await reopenLauncher()
    await create('杂物')
    log('在有别的文件的文件夹里新建', {
      错误: await inLauncher(`document.querySelector('.launcher-error')?.textContent ?? null`),
      窗口: libraryWindows().map((w) => w.getTitle())
    })
    await shotOf(launcherWin, 'v3-error.png')
    await wait(800)
  } catch (e) {
    console.error('[capture]', e)
  } finally {
    app.quit()
  }
}

/**
 * 插件开关（设计文档 8.4）：设置里停用"状态"和"预览"（图片、视频跟着停用）→ 重新加载 →
 * 状态数据还在、只能看，侧栏没有状态分面、没有视频预设 → 全部重新启用 → 恢复。
 */
async function pluginsFlow(win: BrowserWindow, { js, log, shot, tabs }: Tools): Promise<void> {
  const rows = () =>
    js(`[...document.querySelectorAll('.settings-library [data-plugin-id]')].map((r) => (r.querySelector('input').checked ? '☑ ' : '☐ ') + r.querySelector('[data-action=plugin-details]').textContent + (r.querySelector('.plugin-warn') ? '（' + r.querySelector('.plugin-warn').textContent + '）' : ''))`)
  const toggle = (title: string) =>
    js(`[...document.querySelectorAll('.settings-library [data-plugin-id]')].find((r) => r.querySelector('[data-action=plugin-details]').textContent.startsWith(${JSON.stringify(title)})).querySelector('input').click()`)
  const reloaded = async () => {
    await wait(1500)
    for (let i = 0; i < 40; i++) {
      if (await js(`!!document.querySelector('.sidebar')`).catch(() => false)) break
      await wait(250)
    }
    await wait(2000)
  }
  const sidebar = () => js(`[...document.querySelectorAll('.sidebar .nav-group')].map((g) => g.querySelector('.nav-title')?.textContent + ': ' + [...g.querySelectorAll('.nav-label')].map((l) => l.textContent).join('/'))`)

  win.webContents.send('menu:command', 'settings')
  await wait(1000)
  log('设置', { tabs: await tabs(), 插件: await rows() })
  await js(`document.querySelector('.package-row[data-package-id="status"] input').click()`)
  await toggle('预览')
  await wait(300)
  log('停用状态、预览之后', { 插件: await rows(), 提示: await js(`document.querySelector('.settings-foot .muted').textContent`) })
  await shot('g1-settings.png')

  await js(`document.querySelector('.settings-foot button.primary').click()`)
  await reloaded()
  log('重新加载后', { tabs: await tabs(), 侧栏: await sidebar() })
  // 回到"全部"，选中一个有状态的素材（演示库里最后收录的那段文字）
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('全部'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await wait(1200)
  await js(`(() => {
    const card = [...document.querySelectorAll('.tab-pane:not(.hidden) .card')].find((c) => c.querySelector('.card-caption').textContent.includes('配色：主色'));
    card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  })()`)
  await wait(1000)
  log('停用后的素材', {
    角标: await js(`[...document.querySelectorAll('.tab-pane:not(.hidden) .card.selected .badge')].map((b) => b.textContent)`),
    封面: await js(`document.querySelector('.tab-pane:not(.hidden) .card.selected .card-cover').textContent.trim() || (document.querySelector('.tab-pane:not(.hidden) .card.selected img') ? '图' : '')`),
    检查器: await js(`[...document.querySelectorAll('.inspector .section h3')].map((h) => h.textContent)`)
  })
  await shot('g2-disabled.png')

  win.webContents.send('menu:command', 'settings')
  await wait(1000)
  await js(`document.querySelector('.package-row[data-package-id="status"] input').click()`)
  await toggle('预览')
  await js(`document.querySelector('.settings-foot button.primary').click()`)
  await reloaded()
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('全部'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await wait(1500)
  log('重新启用后', {
    侧栏: (await sidebar()).filter((g: string) => g.startsWith('视图') || g.startsWith('状态')),
    角标: await js(`[...document.querySelectorAll('.tab-pane:not(.hidden) .card .badge')].slice(0, 3).map((b) => b.textContent)`)
  })
  await shot('g3-reenabled.png')
}

/**
 * 导出（设计文档 11.12）：选中三张卡片 → "导出…" → 预览 → 导出到截图目录里 → 看写出的文件和索引；
 * 不选、按 ⇧⌘E：导出整个视图。导出位置预先设成截图目录，不往"下载"里写。
 */
async function exportFlow(win: BrowserWindow, dir: string, { js, log, shot, click, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const out = join(dir, 'exported')
  mkdirSync(out, { recursive: true })
  await js(`localStorage.setItem('export.parent', ${JSON.stringify(out)})`)
  const dialog = () =>
    js(`(() => {
      const d = document.querySelector('.export-dialog');
      return d ? { 标题: d.querySelector('.export-title')?.textContent, 预览: [...d.querySelectorAll('.export-summary li')].map((l) => l.textContent), 名称: d.querySelector('.field-text')?.value ?? null, 位置: d.querySelector('.export-parent')?.textContent ?? null, 结果: d.querySelector('.export-path')?.textContent ?? null, 失败: d.querySelector('.export-failed')?.textContent ?? null } : null;
    })()`)
  const pick = (name: string, meta: boolean) =>
    js(`(() => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes(${JSON.stringify(name)}));
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: ${meta} }));
      return !!card;
    })()`)
  const tree = (root: string): string[] => {
    const walk = (d: string, prefix: string): string[] =>
      readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), prefix + e.name + '/') : [prefix + e.name]))
    return walk('', '')
  }

  log('选中', [await pick('作品_2', false), await pick('留白的力量', true), await pick('读书笔记', true)])
  await wait(300)
  log('点检查器里的「导出 3 项…」', await click('.inspector-actions button', '导出'))
  await wait(800)
  log('对话框', await dialog())
  await shot('e1-preview.png')
  await click('.export-dialog button', '导出')
  await wait(2000)
  const done = (await dialog()) as { 结果: string | null } | null
  log('导出之后', done)
  await shot('e2-done.png')
  const exported = done?.结果 ?? ''
  if (exported) {
    log('写出的文件', tree(exported))
    log('索引.md', readFileSync(join(exported, '索引.md'), 'utf8').split('\n').slice(0, 30))
    const texts = tree(exported).filter((f) => f.startsWith('文字/'))
    if (texts[0]) log(texts[0], readFileSync(join(exported, texts[0]), 'utf8').split('\n').slice(0, 12))
  }
  await click('.export-dialog button', '完成')
  await wait(400)

  // 不选：⇧⌘E 导出整个视图
  await key('Escape')
  win.webContents.send('menu:command', 'export')
  await wait(800)
  log('⇧⌘E（没选）', await dialog())
  await key('Escape')
}

/**
 * 视图上方的工具栏：第一行固定（视图、项数、存视图、搜索、显示），临时筛选在第二行、多了换行，
 * 选中后的操作在检查器里。几个筛选、选中几项、看板、最窄的窗口下都检查：有没有被压扁、挤出去。
 */
async function toolbarFlow(win: BrowserWindow, { js, log, shot, click }: Tools): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const measure = () =>
    js(`(() => {
      const bar = ${pane}.querySelector('.toolbar');
      const r = bar.getBoundingClientRect();
      const kids = [...bar.children];
      const fb = ${pane}.querySelector('.filter-bar');
      return {
        第一行: kids.map((k) => k.textContent.trim()).filter(Boolean),
        第一行高: Math.round(r.height),
        挤出去的: kids.filter((k) => k.getBoundingClientRect().right > r.right + 1).map((k) => k.textContent.trim() || k.className),
        压扁的: [...bar.querySelectorAll('button, .toolbar-count')].filter((b) => b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().height > 32).map((b) => b.textContent.trim()),
        筛选行: fb ? { 高: Math.round(fb.getBoundingClientRect().height), 标签: [...fb.querySelectorAll('.chip-label')].map((c) => c.textContent) } : null
      };
    })()`)
  const inspector = () => js(`({ 标题: document.querySelector('.inspector-title')?.textContent ?? null, 操作: [...document.querySelectorAll('.inspector-actions button')].map((b) => b.textContent) })`)

  // 一、四个筛选：在第二行，第一行不变
  for (const name of ['配色', '光影', '进行中', 'png']) await click('.sidebar .nav-item', name)
  await wait(600)
  log('四个筛选', await measure())
  await shot('t1-filters.png')
  log('点「清除筛选」', await click('.filter-bar button', '清除筛选'))
  await wait(400)
  log('清除之后', await measure())

  // 二、选中三项：第一行不变，操作在检查器里
  await click('.sidebar .nav-item', '配色')
  await wait(600)
  await js(`(() => {
    const cards = [...${pane}.querySelectorAll('.card')].slice(0, 3);
    cards.forEach((c, i) => c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: i > 0 })));
  })()`)
  await wait(500)
  log('选中三项', { 工具栏: await measure(), 检查器: await inspector() })
  await shot('t2-selected.png')
  // 点一张没选中的（按在已选中的上面会保留多选，方便直接拖走）
  await js(`(() => { const c = ${pane}.querySelectorAll('.card')[3]; c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })()`)
  await wait(500)
  log('选中一项', await inspector())
  await shot('t2b-one.png')

  // 三、"显示"面板：布局、看板的分列、卡片大小
  await js(`${pane}.querySelector('.display-menu > button').click()`)
  await wait(300)
  log('显示面板', await js(`[...${pane}.querySelectorAll('.display-panel .display-row')].map((r) => r.textContent.trim())`))
  await shot('t3-display.png')
  await js(`[...${pane}.querySelectorAll('.display-panel .segmented button')].find((b) => b.textContent === '看板').click()`)
  await wait(600)
  log('换成看板后的面板', await js(`[...${pane}.querySelectorAll('.display-panel .display-row')].map((r) => r.textContent.trim())`))
  await shot('t4-kanban-panel.png')
  {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await wait(200)
    log('Esc 之后面板还在吗', await js(`!!${pane}.querySelector('.display-panel')`))
  }

  // 四、最窄的窗口，四个筛选
  for (const name of ['光影', '进行中', 'png']) await click('.sidebar .nav-item', name)
  win.setSize(960, 700)
  await wait(800)
  log('最窄的窗口（960）', await measure())
  await shot('t5-narrow.png')
}

/** 标签分组：界面操作 + 只读数据库核对；分组变化不能重写素材标签。 */
async function tagGroupsFlow(win: BrowserWindow, { js, log, shot }: Tools): Promise<void> {
  const db = new Database(join(process.env.LIBRARY_PATH!, 'library.db'), { readonly: true })
  const records = () => db.prepare("SELECT entity_id, data, seq FROM block WHERE kind = 'tags' ORDER BY entity_id").all()
  const before = JSON.stringify(records())
  const groups = () => {
    const row = db.prepare("SELECT data FROM block b JOIN entity e ON e.id = b.entity_id WHERE kind = 'tagGroups' AND e.deleted_at IS NULL").get() as { data: string } | undefined
    return row ? JSON.parse(row.data).groups as { id: string; title: string; tags: string[] }[] : []
  }
  const click = async (selector: string) => {
    await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('没有 ' + ${JSON.stringify(selector)}); e.click(); })()`)
    await wait(500)
  }
  const menu = async (selector: string, choice: string) => {
    menuChoice = choice
    lastMenu = []
    await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))`)
    await wait(500)
    if (!menuText(lastMenu).includes(choice)) throw new Error(`菜单没有 ${choice}`)
  }
  const name = async (title: string) => {
    await js(`(() => {
      const el = document.querySelector('.tag-group-dialog input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(title)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await click('.tag-group-dialog .primary')
  }
  const add = async (title: string) => { await click('[aria-label="新建标签分组"]'); await name(title) }
  const folder = (id: string) => `[data-tag-group="${id}"]`
  const tag = '[data-tag="光影"]'
  const assertIn = async (id: string) => {
    if (!await js(`!!document.querySelector(${JSON.stringify(`${folder(id)} ${tag}`)})`)) throw new Error(`光影没有显示在 ${id}`)
  }
  const history = async (command: string) => { win.webContents.send('menu:command', command); await wait(600) }
  try {
    await click('[aria-label="新建标签分组"]')
    await click('.tag-group-dialog .export-actions .small')
    if (groups().length) throw new Error('取消仍然创建了分组')
    await add('主题')
    const topic = groups().find((g) => g.title === '主题')!
    await menu(tag, '移到「主题」')
    await assertIn(topic.id)
    if (JSON.stringify(records()) !== before) throw new Error('归组修改了素材标签')
    await click(`${folder(topic.id)} ${tag} .nav-item`)
    const selected = await js(`document.querySelector('.filter-bar')?.textContent.includes('光影')`)
    if (!selected) throw new Error('组内标签不能筛选')
    await click(`${folder(topic.id)} .tag-group-toggle`)
    const collapsed = await js(`(() => { const g = document.querySelector(${JSON.stringify(folder(topic.id))}); return g.querySelector('.tag-group-toggle').getAttribute('aria-expanded') === 'false' && g.querySelector('.tag-group-body').getBoundingClientRect().height < 1 && g.querySelector('.tag-group-toggle').title.includes('1 已选'); })()`)
    if (!collapsed) throw new Error('折叠没有收起，或丢失已选筛选提示')
    await shot('tags-1-collapsed.png')
    win.webContents.reload()
    await wait(3200)
    if (!await js(`document.querySelector(${JSON.stringify(`${folder(topic.id)} .tag-group-toggle`)})?.getAttribute('aria-expanded') === 'false'`)) throw new Error('重新加载没有恢复折叠状态')
    await click(`${folder(topic.id)} .tag-group-toggle`)
    await add('颜色')
    const color = groups().find((g) => g.title === '颜色')!
    await menu(tag, '移到「颜色」')
    await assertIn(color.id)
    await menu(`${folder(color.id)} .tag-group-head`, '重命名分组…')
    await name('主题')
    if (!await js(`document.querySelector('.tag-group-dialog [role="alert"]')?.textContent.includes('同名')`)) throw new Error('重名分组没有提示')
    await name('用途')
    if (groups().find((g) => g.id === color.id)?.title !== '用途') throw new Error('改名没有保存')
    await menu(`${folder(color.id)} .tag-group-head`, '删除分组（保留标签）')
    await assertIn('ungrouped')
    await history('undo')
    await assertIn(color.id)
    await history('redo')
    await assertIn('ungrouped')
    await history('undo')
    await menu(tag, '移到新分组…')
    await name('画面与构图参考')
    const created = groups().find((g) => g.title === '画面与构图参考')!
    await assertIn(created.id)
    await history('undo')
    await assertIn(color.id)
    if (groups().some((g) => g.id === created.id)) throw new Error('移入新分组没有作为一次操作撤销')
    await shot('tags-2-organized.png')
    win.setSize(960, 700)
    await wait(400)
    await js(`document.querySelector('.tag-groups').scrollIntoView({ block: 'end' })`)
    await wait(250)
    await shot('tags-3-narrow.png')
    const overflow = await js(`(() => { const s = document.querySelector('.sidebar-scroll'); return s.scrollWidth - s.clientWidth; })()`)
    if (overflow > 1) throw new Error('窄窗口侧栏横向溢出')

    const saved = JSON.stringify(groups())
    const setPlugin = async (enabled: boolean) => {
      await click('.vault-settings')
      await js(`(() => { const input = [...document.querySelectorAll('.settings-library [data-plugin-id]')].find((r) => r.querySelector('[data-action=plugin-details]')?.textContent.trim() === '标签').querySelector('input'); if (input.checked !== ${enabled}) input.click(); })()`)
      await click('.settings-foot .primary')
      await wait(2800)
      await js(`[...document.querySelectorAll('.sidebar .nav-item')].find((e) => e.textContent.trim() === '全部').click()`)
      await wait(600)
    }
    await setPlugin(false)
    if (await js(`!!document.querySelector('.tag-groups')`)) throw new Error('停用后仍有分组编辑入口')
    if (JSON.stringify(groups()) !== saved) throw new Error('停用后丢失分组数据')
    await setPlugin(true)
    await assertIn(color.id)
    if (JSON.stringify(groups()) !== saved || JSON.stringify(records()) !== before) throw new Error('重新启用后数据发生变化')
    log('标签分组通过：创建取消、移动、筛选、折叠恢复、重名校验、改名、删除与撤销、窄窗口、插件启停；素材标签未改写', groups())
  } finally { db.close() }
}

/** 空白处创建：真实编辑、保存、视图条件、不同布局、插件启停。数据库只读核对结果。 */
async function createFlow(win: BrowserWindow, { js, log, shot, click }: Tools): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const db = new Database(join(process.env.LIBRARY_PATH!, 'library.db'), { readonly: true })
  const count = () => (db.prepare("SELECT count(*) AS n FROM block WHERE kind = 'text'").get() as { n: number }).n
  const rightClick = async (selector: string, choose = false, ctrlClick = false) => {
    menuChoice = choose ? '新建文字' : undefined
    lastMenu = []
    await js(`(() => {
      const el = ${pane}.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('找不到菜单目标：' + ${JSON.stringify(selector)});
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: ${ctrlClick ? 0 : 2}, ctrlKey: ${ctrlClick} }));
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ctrlKey: ${ctrlClick} }));
    })()`)
    await wait(700)
    return menuText(lastMenu)
  }
  const write = async (text: string) => {
    const ready = await js(`(() => {
      const el = ${pane}.querySelector('.reader-editor');
      return !!el && document.activeElement === el && el.value === '';
    })()`)
    if (!ready) throw new Error('创建后没有进入空白文字编辑器并获得焦点')
    await js(`(() => {
      const el = ${pane}.querySelector('.reader-editor');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await wait(1100)
    const row = db.prepare("SELECT entity_id FROM block WHERE kind = 'text' AND json_extract(data, '$.content') = ?").get(text) as { entity_id: string } | undefined
    if (!row) throw new Error('新建的文字没有保存到素材库')
    const data = Object.fromEntries((db.prepare('SELECT kind, data FROM block WHERE entity_id = ?').all(row.entity_id) as { kind: string; data: string }[]).map((b) => [b.kind, JSON.parse(b.data)]))
    log(text, { id: row.entity_id, tags: data.tags?.values, status: data.status?.value })
    return data
  }
  const close = async () => { win.webContents.send('menu:command', 'tab.close'); await wait(500) }
  const nav = async (title: string) => {
    if (!await click('.sidebar .nav-item', title)) throw new Error(`没有侧栏入口：${title}`)
    await wait(550)
  }
  const expectCreate = (items: string[]) => {
    if (items.length !== 1 || items[0] !== '新建文字') throw new Error(`空白处菜单不正确：${items.join('、')}`)
  }
  try {
    // 选中过卡片、取消过素材菜单，再在空白处右击，不能误用上次的选择。
    const originalCount = count()
    const actions = await rightClick('.card')
    if (!actions.some((s) => s.startsWith('打开')) || actions.some((s) => s.startsWith('新建'))) throw new Error('卡片菜单混入新建操作')
    expectCreate(await rightClick('.grid-scroller', false, true))
    if (count() !== originalCount) throw new Error('取消菜单仍然创建了素材')
    if ((await rightClick('.search-input')).length) throw new Error('搜索输入框误弹出素材菜单')
    log('卡片、空白和输入框的菜单各自独立，取消不创建', true)

    await nav('文字')
    await nav('光影')
    await nav('已完成')
    const empty = await js(`!!${pane}.querySelector('.grid-scroller .empty')`)
    if (!empty) throw new Error('演示库的空结果页准备失败')
    expectCreate(await rightClick('.empty p', true))
    const filtered = await write('空白菜单：继承标签与状态')
    if (!filtered.tags?.values?.includes('光影') || filtered.status?.value !== '已完成') throw new Error('新建没有继承视图条件')
    await shot('create-1-editor.png')
    await close()
    const found = await js(`[...${pane}.querySelectorAll('.card-caption')].some((c) => c.textContent === '空白菜单：继承标签与状态')`)
    if (!found) throw new Error('创建后回到视图找不到新文字')

    await js(setLayoutJs(pane, 'table'))
    await wait(450)
    if ((await rightClick('.table-head')).length) throw new Error('表头误弹出空白菜单')
    const rowActions = await rightClick('.table-row')
    if (!rowActions.some((s) => s.startsWith('打开')) || rowActions.some((s) => s.startsWith('新建'))) throw new Error('表格行菜单不正确')
    expectCreate(await rightClick('.table-body', true))
    const table = await write('表格空白处的新文字')
    if (table.status?.value !== '已完成' || !table.tags?.values?.includes('光影')) throw new Error('表格新建丢失视图条件')
    await close()

    await nav('全部')
    await nav('光影')
    await js(setLayoutJs(pane, 'kanban'))
    await wait(600)
    expectCreate(await rightClick('[data-drop-title="进行中"] .kanban-scroller', true))
    const kanban = await write('看板列里的新文字')
    if (kanban.status?.value !== '进行中' || !kanban.tags?.values?.includes('光影')) throw new Error('看板新建没有带上列条件和视图标签')
    await close()
    await shot('create-2-kanban.png')

    // 不符合准入条件时，仍打开已经创建的文字并给出说明。
    await nav('图片')
    expectCreate(await rightClick('.grid-scroller', true))
    const message = await js(`document.querySelector('.toast')?.textContent`)
    if (!message?.includes('不在当前视图中')) throw new Error('不符合视图条件时没有解释新文字的去向')
    await write('图片视图外的新文字')
    await close()
    await nav('全部')
    win.webContents.send('menu:command', 'new')
    await wait(700)
    await write('快捷键仍然可以新建')
    await close()
    await nav('回收站')
    const beforeTrash = count()
    if ((await rightClick('.grid-scroller')).length) throw new Error('回收站提供了新建入口')
    win.webContents.send('menu:command', 'new')
    await wait(300)
    if (count() !== beforeTrash) throw new Error('回收站里仍然新建了素材')

    // 停用、重新启用文字插件：创建项跟着注册表变化。
    const setTextPlugin = async (enabled: boolean) => {
      await js(`document.querySelector('.vault-settings').click()`)
      await wait(500)
      await js(`(() => {
        const input = [...document.querySelectorAll('.settings-library [data-plugin-id]')].find((r) => r.querySelector('[data-action=plugin-details]')?.textContent.trim() === '文字').querySelector('input');
        if (input.checked !== ${enabled}) input.click();
      })()`)
      await wait(100)
      await js(`document.querySelector('.settings-foot .primary').click()`)
      await wait(3000)
      await nav('全部')
    }
    await setTextPlugin(false)
    const disabledCount = count()
    if ((await rightClick('.grid-scroller')).length) throw new Error('文字插件停用后仍提供新建文字')
    win.webContents.send('menu:command', 'new')
    await wait(300)
    if (count() !== disabledCount) throw new Error('文字插件停用后仍能新建文字')
    await setTextPlugin(true)
    expectCreate(await rightClick('.grid-scroller', true))
    await write('重新启用文字插件后新建')
    await close()
    await shot('create-3-restored.png')
    log('创建入口、编辑保存、视图继承、三个布局、取消、快捷键与插件启停全部通过', true)
  } finally {
    db.close()
  }
}

/** 检查真实卡片的过渡、图片节点复用和动画结束后的虚拟化。 */
async function masonryFlow(win: BrowserWindow, { js, log, shot }: Tools): Promise<void> {
  win.webContents.setBackgroundThrottling(false)
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const measure = async (label: string, panels: string[], reverse = false) => {
    const result = await js(`new Promise((resolve) => {
      const grid = ${pane}.querySelector('.grid-scroller');
      const bounds = grid.getBoundingClientRect();
      const originals = [...grid.querySelectorAll('.card')].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > bounds.top && r.top < bounds.bottom;
      });
      const images = originals.flatMap((c) => [...c.querySelectorAll('img')]).filter((i) => i.complete && i.naturalWidth > 0);
      const card = originals[0];
      const widths = new Set([card.style.width]);
      const positions = new Set();
      let detached = 0, lostImages = 0, maxGap = 0, previous = performance.now();
      const start = previous;
      const toggle = () => ${JSON.stringify(panels)}.forEach((p) => document.querySelector('[aria-controls="' + p + '-panel"]').click());
      toggle();
      if (${reverse}) setTimeout(toggle, 75);
      const frame = (now) => {
        widths.add(card.style.width);
        positions.add(Math.round(card.getBoundingClientRect().width * 10));
        maxGap = Math.max(maxGap, now - previous);
        previous = now;
        // 在过渡中，原来可见的卡片和已经解码的图片不能被虚拟列表卸载。
        if (now - start > 20 && now - start < ${reverse ? 280 : 230}) {
          detached += originals.filter((c) => !c.isConnected).length;
          lostImages += images.filter((i) => !i.isConnected || !i.complete || i.naturalWidth === 0).length;
        }
        if (now - start < 500) requestAnimationFrame(frame);
        else resolve({ originals: originals.length, images: images.length, targetWidths: widths.size,
          paintedWidths: positions.size, detached, lostImages, maxGap: Math.round(maxGap),
          animations: grid.getAnimations({ subtree: true }).length, rendered: grid.querySelectorAll('.card').length,
          clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth });
      };
      requestAnimationFrame(frame);
    })`)
    log(label, result)
    if (result.targetWidths > (reverse ? 3 : 2) || result.detached || result.lostImages ||
        result.paintedWidths < 3 || result.animations || result.scrollWidth > result.clientWidth) {
      throw new Error(`瀑布流过渡不稳定：${label}`)
    }
  }
  await measure('收起右栏：卡片只计算一次终点', ['inspector'])
  await measure('收起左栏：图片保持挂载', ['sidebar'])
  await shot('masonry-1-wide.png')
  await measure('展开两栏：卡片连续缩放与换列', ['sidebar', 'inspector'])
  await measure('快速反向：从当前画面接续', ['sidebar'], true)
  await js(`${pane}.querySelector('.grid-scroller').scrollTop = 1100`)
  await wait(500)
  await measure('滚动后收起两栏', ['sidebar', 'inspector'])
  await measure('滚动后展开两栏', ['sidebar', 'inspector'])
  await shot('masonry-2-scrolled.png')
  await js(`(() => { const g = ${pane}.querySelector('.grid-scroller'); g.scrollTop = g.scrollHeight; })()`)
  await wait(400)
  await measure('列表底部收起两栏', ['sidebar', 'inspector'])
  await measure('列表底部展开两栏', ['sidebar', 'inspector'])
  const virtualization = await js(`(() => {
    const grid = ${pane}.querySelector('.grid-scroller');
    const bounds = grid.getBoundingClientRect();
    return [...grid.querySelectorAll('.card')].every((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > bounds.top - 610 && r.top < bounds.bottom + 610;
    });
  })()`)
  if (!virtualization) throw new Error('动画后未释放超出虚拟列表范围的卡片')
  log('动画后恢复虚拟化', virtualization)

  win.setSize(960, 700)
  await wait(500)
  await js(`${pane}.querySelector('.grid-scroller').scrollTop = 0`)
  await wait(400)
  await measure('窄窗口从一列展开到多列', ['sidebar', 'inspector'])
  await measure('窄窗口恢复一列', ['sidebar', 'inspector'])

  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  try {
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await wait(100)
    await js(`document.querySelectorAll('.panel-toggle').forEach((b) => b.click())`)
    await wait(100)
    const immediate = await js(`(() => {
      const g = ${pane}.querySelector('.grid-scroller');
      return !g.classList.contains('resizing') && g.getAnimations({ subtree: true }).length === 0 && g.clientWidth === innerWidth-document.querySelector('.activity-bar').getBoundingClientRect().width;
    })()`)
    if (!immediate) throw new Error('减少动态效果时瀑布流未立即完成布局')
    log('减少动态效果：内容立即就位', immediate)
    await js(`document.querySelectorAll('.panel-toggle').forEach((b) => b.click())`)
    await wait(100)
  } finally {
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    dbg.detach()
  }
  // 独立于逐帧计时，保留过渡中的画面供人工检查。
  win.setSize(1440, 900)
  await wait(500)
  await shot('masonry-3-before.png')
  await js(`document.querySelector('[aria-controls="inspector-panel"]').click()`)
  await wait(80)
  await shot('masonry-4-during.png')
  await wait(400)
  await shot('masonry-5-after.png')
}

/** 两栏独立收起、编辑保存、切换标签页、窄窗口和重新加载后的工作区恢复。 */
async function panelsFlow(win: BrowserWindow, { js, log, shot }: Tools): Promise<void> {
  // 隐藏的验证窗口也逐帧运行，才能检查宽度过渡与中途反向。
  win.webContents.setBackgroundThrottling(false)
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const noteInput = `[...document.querySelectorAll('.inspector .section')].find((s) => s.querySelector('h3')?.textContent === '笔记').querySelector('textarea.autosave')`
  const toggle = async (panel: string) => {
    await js(`document.querySelector('[aria-controls="${panel}-panel"]').click()`)
    await wait(400)
  }
  const check = async (label: string, sidebar: boolean, inspector: boolean, expected = { sidebar: 220, inspector: 300 }) => {
    const state = await js(`(() => {
      const width = (s) => Math.round(document.querySelector(s).getBoundingClientRect().width);
      const controls = [...document.querySelectorAll('.panel-toggle')].map((b) => {
        const r = b.getBoundingClientRect();
        return { expanded: b.getAttribute('aria-expanded') === 'true', reachable: b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), left: r.x };
      });
      return { sidebar: width('#sidebar-panel'), inspector: width('#inspector-panel'), rail: width('.activity-bar'), main: width('.main'), window: innerWidth, controls };
    })()`)
    log(label, state)
    if (state.sidebar !== (sidebar ? expected.sidebar : 0) || state.inspector !== (inspector ? expected.inspector : 0) ||
        state.rail !== 48 || state.main !== state.window - state.rail - state.sidebar - state.inspector ||
        state.controls.length !== 2 || !state.controls.every((c: { reachable: boolean }) => c.reachable) ||
        state.controls[0].expanded !== sidebar || state.controls[1].expanded !== inspector ||
        (!sidebar && state.controls[0].left < 90)) throw new Error(`两栏验证失败：${label}`)
  }

  await check('默认展开', true, true)
  const title = await js(`(() => {
    const card = ${pane}.querySelector('.card');
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    return card.querySelector('.card-caption').title;
  })()`)
  await wait(400)
  // 输入后立即用菜单收起，触发失焦提交；重新加载后还要能读到这份笔记。
  const note = '收起检查器前的笔记'
  await js(`(() => {
    const input = ${noteInput};
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(note)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  win.webContents.send('menu:command', 'panel.inspector')
  await wait(400)
  await check('只收起右栏', true, false)
  await shot('panels-1-right-hidden.png')
  const motion = await js(`new Promise((resolve) => {
    const panel = document.querySelector('#sidebar-panel');
    const content = panel.querySelector('.sidebar');
    const initialContentWidth = Math.round(content.getBoundingClientRect().width);
    const samples = [];
    const start = performance.now();
    document.querySelector('[aria-controls="sidebar-panel"]').click();
    const frame = (now) => {
      samples.push({ ms: Math.round(now - start), width: Math.round(panel.getBoundingClientRect().width), contentWidth: Math.round(content.getBoundingClientRect().width) });
      if (now - start < 380) requestAnimationFrame(frame);
      else resolve({ samples, initialContentWidth, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, inert: panel.inert, visibility: getComputedStyle(panel).visibility });
    };
    requestAnimationFrame(frame);
  })`)
  log('侧栏逐帧过渡', motion)
  if ((!motion.reduced && !motion.samples.some((s: { width: number }) => s.width > 0 && s.width < 220)) ||
      !motion.samples.every((s: { contentWidth: number }) => s.contentWidth === motion.initialContentWidth) ||
      !motion.inert || motion.visibility !== 'hidden') throw new Error('侧栏动画、内容宽度或隐藏状态不正确')
  await check('两栏收起', false, false)
  await shot('panels-2-both-hidden.png')

  await js(`document.querySelector('[aria-controls="sidebar-panel"]').click()`)
  await wait(60)
  await toggle('sidebar')
  await check('展开途中再次收起', false, false)

  win.webContents.send('menu:command', 'tab.new')
  await wait(400)
  await check('新标签页保持收起', false, false)
  win.webContents.send('menu:command', 'tab.close')
  await wait(400)
  const selected = await js(`${pane}.querySelector('.card.selected .card-caption')?.title`)
  if (selected !== title) throw new Error('收起两栏、切换标签页后选中项丢失')

  win.setSize(960, 700)
  await wait(500)
  await check('窄窗口两栏收起', false, false)
  await shot('panels-3-narrow.png')
  await wait(800) // 等待工作区防抖保存
  await new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.reload()
  })
  await wait(2000)
  await check('重新加载后保持收起', false, false)
  await toggle('inspector')
  await check('只展开右栏', false, true)
  await js(`(() => {
    const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').title === ${JSON.stringify(title)});
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  })()`)
  await wait(400)
  const savedNote = await js(`${noteInput}?.value`)
  if (savedNote !== note) throw new Error('收起检查器前的笔记未保存')
  log('失焦提交的笔记重新加载后仍在', savedNote)
  await shot('panels-4-left-hidden.png')
  await toggle('sidebar')
  await check('两栏重新展开', true, true)
  await shot('panels-5-restored.png')

  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  try {
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await wait(100)
    await js(`document.querySelectorAll('.panel-toggle').forEach((b) => b.click())`)
    await wait(50)
    await check('减少动态效果时立即收起', false, false)
    const duration = await js(`getComputedStyle(document.querySelector('.app')).transitionDuration`)
    if (duration !== '0s') throw new Error('未遵循减少动态效果设置')
    await js(`document.querySelectorAll('.panel-toggle').forEach((b) => b.click())`)
    await wait(50)
    await check('减少动态效果时立即展开', true, true)
  } finally {
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    dbg.detach()
  }
  // 真正拖动分隔线，键盘调整另一侧，并检查按库保存及窄窗口约束。
  win.setSize(1440, 900); await wait(400)
  const handle = await js(`(() => {const r=document.querySelector('.panel-resize-left').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+120)}})()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...handle })
  win.webContents.sendInputEvent({ type: 'mouseDown', ...handle, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x + 60, y: handle.y })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: handle.x + 60, y: handle.y, button: 'left', clickCount: 1 })
  await js(`document.querySelector('.panel-resize-right').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`)
  await wait(400)
  await check('拖动与键盘调整宽度', true, true, { sidebar: 280, inspector: 310 })
  await wait(600)
  await new Promise<void>(resolve => { win.webContents.once('did-finish-load', () => resolve()); win.webContents.reload() })
  await wait(2000)
  await check('重启后恢复宽度', true, true, { sidebar: 280, inspector: 310 })
  await shot('panels-6-resized.png')
  // 极限宽度应为中央保留至少 320px，扩窗后恢复偏好。
  await js(`(async()=>{for(let i=0;i<20;i++){document.querySelector('.panel-resize-right').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await new Promise(r=>setTimeout(r,25))}})()`)
  win.setSize(960, 700); await wait(400)
  if (!await js(`document.querySelector('.main').clientWidth>=319 && document.querySelector('#inspector-panel').clientWidth>=240`)) throw new Error('宽度偏好挤掉中央区域')
  win.setSize(1440, 900); await wait(400)
  await check('扩窗恢复期望宽度', true, true, { sidebar: 280, inspector: 480 })
  await js(`document.querySelectorAll('.panel-resize').forEach(e=>e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})))`)
  await wait(400)
  await check('双击恢复默认宽度', true, true)
}

/**
 * 在应用里收进一个新的 PDF（拖进窗口）：读信息、渲染封面、抽文字都在核心进程里做（不是测试里的 Node）。
 * 核心进程是 Electron 的 utility 进程，pdf.js 在这里曾经认错环境（要浏览器的 Worker）。
 */
async function pdfDropFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools): Promise<void> {
  const cupsfilter = ['/usr/sbin/cupsfilter', '/usr/bin/cupsfilter'].find(existsSync)
  if (!cupsfilter) return log('没有 cupsfilter，跳过', null)
  const txt = join(dir, '拖进来的手册.txt')
  writeFileSync(txt, `拖进来的手册\n\n第一页：${Date.now()}\n留白与节奏\n\f第二页：网格`)
  const pdf = join(dir, '拖进来的手册.pdf')
  writeFileSync(pdf, execFileSync(cupsfilter, ['-m', 'application/pdf', txt], { stdio: ['ignore', 'pipe', 'ignore'] }))

  const at = await js(`(() => { const r = document.querySelector('.tab-pane:not(.hidden) .collection').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await dbg.sendCommand('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: { items: [], files: [pdf], dragOperationsMask: 1 } })
  }
  dbg.detach()
  await wait(6000)
  log(
    '收进来的 PDF',
    await js(`(() => {
      const card = [...document.querySelectorAll('.tab-pane:not(.hidden) .card')].find((c) => c.querySelector('.card-caption').textContent.includes('拖进来的手册'));
      if (!card) return null;
      return {
        标题: card.querySelector('.card-caption').textContent,
        角标: [...card.querySelectorAll('.badge')].map((b) => b.textContent),
        失败: card.querySelector('.badge-failed')?.title ?? null,
        封面: card.querySelector('.card-cover img')?.getAttribute('src')?.split('/').slice(-2).join('/') ?? null
      };
    })()`)
  )
  await shot('pd1-dropped.png')

  // 抽出来的文字能搜到：搜只在这份 PDF 第二页上的字
  await js(`(() => {
    const input = document.querySelector('.tab-pane:not(.hidden) .search-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '第二页 网格');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(1500)
  log(
    '搜「第二页 网格」',
    await js(`[...document.querySelectorAll('.tab-pane:not(.hidden) .card')].map((c) => ({ 标题: c.querySelector('.card-caption').textContent, 命中: c.querySelector('.card-snippet')?.textContent ?? null }))`)
  )
  await shot('pd2-search.png')
}

/**
 * 改名（设计文档 11.14）：右键"重命名…"→ 一项的对话框（扩展名在旁边）→ 回车改名，磁盘上的文件跟着改 →
 * 点检查器的标题改名 → 在"图片"里选三张按回车：统一命名加序号、替换文字的预览 → 改名 → 撤销。
 */
async function renameFlow(win: BrowserWindow, { js, log, shot, click, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const root = process.env.LIBRARY_PATH ?? ''
  const cardJs = (name: string) => `[...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent === ${JSON.stringify(name)})`
  const pick = (name: string, meta: boolean) =>
    js(`(() => { const c = ${cardJs(name)}; c?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: ${meta} })); return !!c })()`)
  const rightClick = async (name: string, choice?: string) => {
    menuChoice = choice
    lastMenu = []
    await js(`(() => {
      const c = ${cardJs(name)};
      c?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      c?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    })()`)
    await wait(600)
    return menuText(lastMenu)
  }
  const cards = () => js(`[...${pane}.querySelectorAll('.card .card-caption')].map((c) => c.textContent)`)
  const dialog = () =>
    js(`(() => {
      const d = document.querySelector('.export-dialog');
      return d ? { 标题: d.querySelector('.export-title')?.textContent, 输入: [...d.querySelectorAll('input')].map((i) => i.value), 扩展名: d.querySelector('.rename-ext')?.textContent ?? null, 预览: [...d.querySelectorAll('.rename-preview li')].map((l) => l.textContent), 说明: d.querySelector('.export-hint')?.textContent ?? null, 错误: d.querySelector('.export-failed')?.textContent ?? null, 选中的文字: window.getSelection()?.toString() || (document.activeElement?.value ?? '').slice(document.activeElement?.selectionStart ?? 0, document.activeElement?.selectionEnd ?? 0) } : null;
    })()`)
  /** 给对话框里第 i 个输入框填字（React 认得的方式）。 */
  const type = (i: number, text: string) =>
    js(`(() => {
      const input = document.querySelectorAll('.export-dialog input')[${i}];
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  const enterIn = (i: number) => js(`document.querySelectorAll('.export-dialog input')[${i}].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  const toast = () => js(`document.querySelector('.toast')?.textContent ?? null`)
  /** 仓库里叫这个名字的文件在不在（files/<身份>/<名字>）。 */
  const onDisk = (name: string) => readdirSync(join(root, 'files')).some((id) => existsSync(join(root, 'files', id, name)))

  // 一、右键 → 重命名…
  log('右键「读书笔记.md」', await rightClick('读书笔记.md', '重命名'))
  await wait(400)
  log('对话框', await dialog())
  await shot('r1-rename-one.png')
  await type(0, '设计中的设计')
  await enterIn(0)
  await wait(800)
  log('改名之后', { 提示: await toast(), 卡片: (await cards()).filter((c: string) => c.includes('设计')), 磁盘上: { 旧: onDisk('读书笔记.md'), 新: onDisk('设计中的设计.md') } })

  // 二、点检查器的标题
  await pick('竖屏.mp4', false)
  await wait(500)
  log('点检查器标题', await click('.inspector-title.renamable button', '竖屏'))
  await wait(400)
  await js(`(() => { const e=document.querySelector('.inspector-title-editor input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'竖屏/样片'); e.dispatchEvent(new Event('input',{bubbles:true})); })()` )
  await wait(100)
  await click('.inspector-title-editor button', '保存')
  await wait(800)
  log('检查器标题改名之后', { 标题: await js(`document.querySelector('.inspector-title')?.textContent`), 磁盘上: onDisk('竖屏_样片.mp4') })
  await shot('r2-inspector.png')

  // 三、在"图片"里选三张，按回车：一批
  await click('.sidebar .nav-item', '图片')
  await wait(1200)
  const shown = ((await cards()) as string[]).filter((c) => c.startsWith('作品_')).slice(0, 3)
  log('选中', shown)
  await pick(shown[0], false)
  await pick(shown[1], true)
  await pick(shown[2], true)
  await wait(300)
  await key('Enter')
  await wait(500)
  log('一批：打开时', await dialog())
  await type(0, '海报')
  await wait(200)
  log('一批：统一命名「海报」', await dialog())
  await shot('r3-batch-number.png')
  await click('.rename-modes button', '替换文字')
  await wait(200)
  await type(0, '作品')
  await type(1, '参考图')
  await wait(200)
  log('一批：把「作品」换成「参考图」', await dialog())
  await shot('r4-batch-replace.png')
  await click('.export-dialog button', '改名')
  await wait(1200)
  log('一批改完', { 提示: await toast(), 卡片: ((await cards()) as string[]).filter((c) => c.startsWith('参考图_')) })
  await shot('r5-batch-done.png')

  // 四、撤销
  win.webContents.send('menu:command', 'undo')
  await wait(1000)
  log('撤销之后', { 提示: await toast(), 卡片: ((await cards()) as string[]).filter((c) => shown.includes(c)), 磁盘上: shown.map(onDisk) })
}

/**
 * 删除（设计文档 11.13）：右键菜单（系统菜单截不到：记下弹出了什么，按事先选好的那一项回答）→ 移到回收站 →
 * 检查器底部的入口 → 回收站里右键"彻底删除…"→ 确认框 → 删掉仓库记录以后原件保留在文件空间→
 * 清空回收站的入口 → 输入框里 ⌘⌫ 删掉光标前的一行。
 */
async function purgeFlow(win: BrowserWindow, dir: string, { js, log, shot, click, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const cardJs = (name: string) => `[...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent === ${JSON.stringify(name)})`
  const pick = (name: string, meta: boolean) =>
    js(`(() => { const c = ${cardJs(name)}; c?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: ${meta} })); return !!c })()`)
  /** 在卡片上按右键；choice：菜单里点哪一项（按字），不给就是什么也不点。返回弹出的菜单。 */
  const rightClick = async (name: string, choice?: string) => {
    menuChoice = choice
    lastMenu = []
    await js(`(() => {
      const c = ${cardJs(name)};
      c?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      c?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    })()`)
    await wait(600)
    return menuText(lastMenu)
  }
  const cards = () => js(`[...${pane}.querySelectorAll('.card .card-caption')].map((c) => c.textContent)`)
  const toast = () => js(`document.querySelector('.toast')?.textContent ?? null`)
  const dialog = () =>
    js(`(() => {
      const d = document.querySelector('.purge-dialog');
      return d ? { 标题: d.querySelector('.export-title')?.textContent, 内容: [...d.querySelectorAll('.export-summary li')].map((l) => l.textContent), 不删: d.querySelector('.export-failed')?.textContent ?? null, 提醒: d.querySelector('.purge-warning')?.textContent ?? null, 按钮: [...d.querySelectorAll('button')].map((b) => b.textContent), 焦点: document.activeElement?.textContent ?? null } : null;
    })()`)
  const toolbar = () => js(`[...${pane}.querySelectorAll('.toolbar button')].map((b) => b.textContent)`)

  // 一、"全部"里右键：弹出的菜单
  log('右键「竖屏.mp4」弹出的菜单', await rightClick('竖屏.mp4'))
  log('右键「读书笔记.md」弹出的菜单', await rightClick('读书笔记.md'))
  log('选中的（右键会选中它）', await js(`[...${pane}.querySelectorAll('.card.selected .card-caption')].map((c) => c.textContent)`))
  log('工具栏', await toolbar())
  await shot('p1-selected.png')

  // 多选以后在选中的上面右键：整个选择
  await pick('竖屏.mp4', true)
  log('多选后右键（选中的上面）', await rightClick('竖屏.mp4'))

  // 二、菜单里点"移到回收站"
  await rightClick('竖屏.mp4', '移到仓库回收站')
  await wait(300)
  log('移到回收站之后的提示', await toast())
  log('还在「全部」里吗', (await cards()).some((c: string) => c.includes('竖屏.mp4')) || (await cards()).some((c: string) => c.includes('读书笔记.md')))
  await shot('p2-trashed.png')

  // 三、检查器底部的入口
  await pick('版式手册.pdf', false)
  await wait(500)
  log('检查器底部', await js(`[...document.querySelectorAll('.inspector-foot > *')].map((e) => e.textContent)`))

  // 四、回收站：右键，彻底删除…
  await click('.sidebar .nav-item', '回收站')
  await wait(1200)
  log('回收站里', await cards())
  log('回收站工具栏（没选）', await toolbar())
  await shot('p3-trash.png')
  log('回收站里右键「读书笔记.md」', await rightClick('读书笔记.md'))
  await pick('竖屏.mp4', true)
  log('回收站工具栏（选了两项）', await toolbar())
  log('检查器底部（回收站里）', await js(`[...document.querySelectorAll('.inspector-foot > *')].map((e) => e.textContent)`))
  await rightClick('竖屏.mp4', '彻底删除')
  await wait(800)
  log('确认框', await dialog())
  await shot('p4-confirm.png')

  // 焦点在"取消"上：回车不会误删
  await click('.purge-dialog button', '彻底删除')
  await wait(1500)
  log('删完', await dialog())
  await shot('p5-done.png')
  const bin = join(dir, '废纸篓')
  log('废纸篓里（应为空，仓库删除保留原件）', existsSync(bin) ? readdirSync(bin).map((f) => f.replace(/^\d+-/, '')) : [])
  await click('.purge-dialog button', '完成')
  await wait(600)
  log('回收站里（删完）', await cards())
  log('回收站工具栏', await toolbar())
  await shot('p6-after.png')

  // 五、⌘⌫：没选东西时提示；输入框里删掉光标前的一行
  win.webContents.send('menu:command', 'trash')
  await wait(300)
  log('没选东西时 ⌘⌫', await toast())
  await js(`(() => {
    const input = ${pane}.querySelector('.search-input');
    input.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, '海边 日落');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange(3, 3);
  })()`)
  win.webContents.send('menu:command', 'trash')
  await wait(300)
  log('输入框里 ⌘⌫（「海边 日落」，光标在「日」前）', await js(`${pane}.querySelector('.search-input').value`))
  await key('Escape')
}

/**
 * PDF（设计文档 11.11）：侧栏"PDF" → 双击打开阅读器（渲染、文字层）→ ← → 翻页 →
 * 在"全部"里搜只在第三页出现的词，从结果打开：直接翻到第三页、标出来 → 空格预览。
 */
async function pdfFlow(_win: BrowserWindow, { js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const viewer = () =>
    js(`(() => {
      const v = ${pane}.querySelector('.pdf-viewer');
      if (!v) return null;
      const pages = [...v.querySelectorAll('.pdf-page')];
      return {
        状态: v.querySelector('.pdf-status')?.textContent ?? null,
        页码: [...v.querySelectorAll('.pdf-bar .player-time')].map((e) => e.textContent).join(' '),
        页数: pages.length,
        已画: pages.filter((p) => p.querySelector('canvas').width > 0).map((p) => p.dataset.page),
        文字层: pages.map((p) => p.querySelectorAll('.textLayer span').length).filter((n) => n > 0).length,
        标出: [...v.querySelectorAll('.textLayer mark')].map((m) => m.closest('.pdf-page').dataset.page + ':' + m.textContent)
      };
    })()`)
  const openCard = (name: string) =>
    js(`(() => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(name)}));
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return !!card;
    })()`)

  log('点侧栏「PDF」', await click('.sidebar .nav-item', 'PDF'))
  await wait(1200)
  log('卡片', await js(`[...${pane}.querySelectorAll('.card')].map((c) => [...c.querySelectorAll('.badge')].map((b) => b.textContent).join('/') + ' ' + c.querySelector('.card-caption').textContent + (c.querySelector('img') ? '（有封面）' : ''))`))
  log('检查器', await js(`[...document.querySelectorAll('.inspector .section')].map((s) => s.textContent.trim().slice(0, 60))`))
  await shot('p1-cards.png')

  log('双击', await openCard('版式手册'))
  await wait(2500)
  log('阅读器', { tabs: await tabs(), 阅读器: await viewer() })
  await shot('p2-viewer.png')
  await key('ArrowRight')
  await wait(1200)
  log('→ 翻页', await viewer())

  // 从搜索结果打开：翻到命中的那一页
  await key('1', 'meta')
  await wait(600)
  await click('.sidebar .nav-item', '全部')
  await wait(800)
  await js(`(() => {
    const input = ${pane}.querySelector('.search-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '节奏感');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(1200)
  log('搜「节奏感」', await js(`[...${pane}.querySelectorAll('.card')].map((c) => c.querySelector('.card-caption').textContent + ' ← ' + (c.querySelector('.card-snippet')?.textContent ?? ''))`))
  await shot('p3-search.png')
  log('从结果打开', await openCard('版式手册'))
  await wait(2500)
  log('阅读器', await viewer())
  await shot('p4-hit.png')

  // 空格预览：第一页
  await key('1', 'meta')
  await wait(600)
  await js(`${pane}.querySelector('.card')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await key(' ')
  await wait(800)
  log('空格预览', await js(`(() => { const i = document.querySelector('.preview .preview-img'); return i ? i.naturalWidth + '×' + i.naturalHeight : null })()`))
}

/**
 * 文字上的批注（设计文档 11.10）：打开读书笔记 → 选中一句、批注 → 再划一句不写字 → 摘句的卡片 →
 * 双击回到原文那一处 → 改掉原文：失配提示、"原文已改" → 撤销。
 */
async function highlightFlow(win: BrowserWindow, { js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const menu = (command: string) => win.webContents.send('menu:command', command)
  /** 在正文里选中一段字（从含有 start 的地方起，长 length 个字），松开鼠标。 */
  const selectText = (start: string, length: number) =>
    js(`(() => {
      const root = ${pane}.querySelector('.reader-doc');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(${JSON.stringify(start)});
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, Math.min(n.data.length, i + ${length}));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return sel.toString();
      }
      return null;
    })()`)
  const layer = () =>
    js(`(() => {
      const l = document.querySelector('.content-selection-layers');
      return l ? {
        划线: l.querySelectorAll('.content-quote-mark').length,
        有批注的: l.querySelectorAll('.content-quote-mark.noted').length,
        选中的: l.querySelectorAll('.content-quote-mark.selected').length,
        按钮: !!document.querySelector('.content-selection-menu'),
        输入框: !!document.querySelector('.selection-note-dialog'),
        小条: l.querySelector('.content-quote-chip')?.textContent ?? null,
        找不到: l.querySelector('.content-quote-chip.missing')?.textContent ?? null
      } : null;
    })()`)
  const typeNote = (text: string) =>
    js(`(() => {
      const input = document.querySelector('.selection-note-dialog textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.selection-note-dialog button')].find(b => b.textContent === '保存批注').click();
    })()`)
  const inspector = () => js(`[...document.querySelectorAll('.inspector .section')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent.trim().slice(0, 60))`)
  const openCard = (name: string) =>
    js(`(() => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(name)}));
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return !!card;
    })()`)

  log('点侧栏「文档」', await click('.sidebar .nav-item', '文档'))
  await wait(1000)
  log('打开读书笔记', await openCard('读书笔记'))
  await wait(1500)

  log('选中', await selectText('留白不是', 18))
  await wait(400)
  log('选中之后', await layer())
  await click('.content-selection-menu button', '添加批注')
  await wait(300)
  log('点「批注」', await layer())
  await typeNote('可以放进卡片排版里试试 #留白')
  await wait(1200)
  log('写完', { 叠加层: await layer(), 检查器: await inspector() })
  await shot('h1-annotated.png')

  // 只划线，不写字
  log('再选中', await selectText('换个角度看日常', 7))
  await wait(300)
  await click('.content-selection-menu button', '添加批注')
  await wait(300)
  await typeNote('')
  await wait(1200)
  log('只划线', await layer())

  // 摘句的卡片
  await key('1', 'meta')
  await wait(600)
  log('点侧栏「批注」', await click('.sidebar .nav-item', '批注'))
  await wait(1500)
  log('批注视图', await js(`[...${pane}.querySelectorAll('.card')].map((c) => [...c.querySelectorAll('.badge')].map((b) => b.textContent).join('/') + ' | ' + c.querySelector('.card-cover').textContent.slice(0, 30) + ' | ' + c.querySelector('.card-caption').textContent)`))
  await shot('h2-cards.png')

  // 双击摘句：回到原文那一处
  log('双击摘句', await openCard('可以放进卡片排版'))
  await wait(1500)
  log('回到原文', { tabs: await tabs(), 叠加层: await layer(), 检查器: await inspector() })
  await shot('h3-reveal.png')

  // 改掉原文：这一句没了
  await key('Escape')
  await key('e')
  await wait(500)
  log('按 E 之后', await js(`({ 编辑框: !!${pane}.querySelector('.reader-editor'), 焦点: document.activeElement?.tagName + '.' + document.activeElement?.className, 按钮: ${pane}.querySelector('.reader-bar .small:last-child')?.textContent })`))
  await js(`(() => {
    const t = ${pane}.querySelector('.reader-editor');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, t.value.replace(/- 留白不是.*\\n/, ''));
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`)
  await wait(2500)
  log('改掉原文之后', await layer())
  await js(`${pane}.querySelector('.content-quote-chip.missing')?.click()`)
  await wait(800)
  log('点提示', await inspector())
  await shot('h4-lost.png')

  menu('undo')
  await wait(2500)
  log('撤销', { 提示: await js(`document.querySelector('.toast')?.textContent ?? null`), 叠加层: await layer(), 检查器: await inspector() })
}

/**
 * 双链与嵌入（设计文档 11.9）：⌘N 新建文字 → 打 [[作品 用选择器插入链接，![[分形 嵌入视频，![[读书 嵌入文档 →
 * 回到阅读：链接、嵌入 → 点链接打开图片，检查器里"提到它的" → 把卡片拖进编辑器插入嵌入。
 */
async function linksFlow(win: BrowserWindow, { js, log, shot, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const menu = (command: string) => win.webContents.send('menu:command', command)
  /** 在编辑器末尾接着打字（光标在最后）。 */
  const typeMore = (text: string) =>
    js(`(() => {
      const t = ${pane}.querySelector('.reader-editor');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, t.value + ${JSON.stringify(text)});
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  const picker = () =>
    js(`(() => {
      const p = ${pane}.querySelector('.link-picker');
      return p ? { 标题: p.querySelector('.link-picker-head')?.textContent, 候选: [...p.querySelectorAll('.link-picker-item')].map((i) => (i.classList.contains('active') ? '▸' : '') + i.textContent) } : null;
    })()`)
  const editorKey = (k: string) => js(`${pane}.querySelector('.reader-editor').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`)
  const value = () => js(`${pane}.querySelector('.reader-editor')?.value`) as Promise<string>
  const inspector = () => js(`[...document.querySelectorAll('.inspector .section')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent.trim().slice(0, 50))`)

  menu('new')
  await wait(1000)
  await typeMore('# 配色笔记\n\n冷暖对比参考 [[作品')
  await wait(800)
  log('打 [[作品', await picker())
  await editorKey('ArrowDown')
  await wait(200)
  log('↓', await picker())
  await editorKey('Enter')
  await wait(400)
  log('回车之后', { 选择器: await picker(), 文字: await value() })
  await typeMore('，节奏可以像这段：\n\n![[分形')
  await wait(800)
  log('打 ![[分形', await picker())
  await editorKey('Enter')
  await wait(400)
  await typeMore('\n\n读书时记的：\n\n![[读书')
  await wait(800)
  log('打 ![[读书', await picker())
  await editorKey('Enter')
  await wait(400)
  await typeMore('\n\n还没收录的：[[不存在的东西]]')
  await shot('l1-editing.png')
  const source = await value()
  log('源文', source)
  await editorKey('Escape')
  await wait(2000)
  log('阅读', {
    标题: await js(`${pane}.querySelector('.reader-bar .player-title')?.textContent`),
    链接: await js(`[...${pane}.querySelectorAll('.reader-page a.wikilink')].map((a) => a.className + ' ' + a.textContent)`),
    嵌入: await js(`[...${pane}.querySelectorAll('.reader-page .embed')].map((e) => (e.querySelector('img') ? '图' : '') + (e.querySelector('video') ? '视频' : '') + (e.querySelector('.embed-text') ? '文字' : '') + ' ' + (e.querySelector('.embed-caption')?.textContent ?? e.textContent.slice(0, 20)))`),
    检查器: await inspector()
  })
  await shot('l2-reading.png')

  // 点链接：打开那张图；它的检查器里有"提到它的"
  await js(`${pane}.querySelector('.reader-page a.wikilink')?.click()`)
  await wait(1500)
  log('点链接', { tabs: await tabs(), 检查器: await inspector() })
  await shot('l3-backlink.png')

  // 回到文字，把那张图拖进编辑器：插入嵌入
  const img = /\[\[([0-9A-HJKMNP-TV-Z]{26})\|/.exec(source)?.[1]
  await key('ArrowLeft', 'ctrl')
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('配色笔记'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await wait(800)
  await key('e')
  await wait(500)
  await js(`(() => {
    const t = ${pane}.querySelector('.reader-editor');
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
    const dt = new DataTransfer();
    dt.setData('application/x-rm-entities', JSON.stringify([${JSON.stringify(img)}]));
    t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`)
  await wait(800)
  log('拖进来之后的末尾', ((await value()) ?? '').slice(-60))
  await editorKey('Escape')
  await wait(1500)
  log('嵌入数', await js(`${pane}.querySelectorAll('.reader-page .embed').length`))
  await shot('l4-dropped.png')

  // 卡片上：链接、嵌入只显示字
  await key('1', 'meta')
  await wait(800)
  log('卡片', await js(`(() => { const c = [...${pane}.querySelectorAll('.card')].find((c) => c.textContent.includes('配色笔记')); return c ? c.querySelector('.card-cover').textContent.slice(0, 80) : null })()`))
}

/**
 * 全文搜索（设计文档 11.8）：在"全部"里搜"留白"（笔记、摘录、文档里都有）→ 卡片上命中的那一句 →
 * 文件名、两个词 → 另存为视图 → 从结果里打开文档，标出搜到的词 → 在文字标签页里按 ⌘F 开"全部"来搜。
 */
async function searchFlow(win: BrowserWindow, { js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const menu = (command: string) => win.webContents.send('menu:command', command)
  const search = async (text: string) => {
    await js(`(() => {
      const input = ${pane}.querySelector('.search-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    await wait(900)
    return {
      数量: await js(`${pane}.querySelector('.toolbar-count')?.textContent`),
      卡片: await js(`[...${pane}.querySelectorAll('.card')].map((c) => c.querySelector('.card-caption').textContent + (c.querySelector('.card-snippet') ? '  ← ' + c.querySelector('.card-snippet').textContent + '  [' + [...c.querySelectorAll('.card-snippet mark')].map((m) => m.textContent).join('/') + ']' : ''))`)
    }
  }

  log('搜「留白」', await search('留白'))
  await shot('q1-search.png')
  log('搜「作品_2」（文件名）', await search('作品_2'))
  log('搜「留白 构图」（两个词）', await search('留白 构图'))
  log('搜「，」（只有标点）', (await search('，')).数量)
  log('搜「留白」', (await search('留白')).数量)

  // 另存为视图：搜索成了视图的一部分
  log('点「另存为视图」', await click('.toolbar button', '另存为视图'))
  await js(`(() => {
    const input = ${pane}.querySelector('.name-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '留白相关');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(1000)
  log('另存之后', {
    tabs: await tabs(),
    侧栏视图: await js(`[...document.querySelectorAll('.sidebar .nav-item .nav-label')].map((e) => e.textContent).filter((t) => t.includes('留白'))`),
    搜索框: await js(`${pane}.querySelector('.search-input')?.value`),
    数量: await js(`${pane}.querySelector('.toolbar-count')?.textContent`)
  })
  await shot('q2-saved.png')

  // 从结果里打开文档：标出搜到的词
  await js(`(() => {
    const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes('读书笔记'));
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`)
  await wait(1200)
  log('打开读书笔记', {
    tabs: await tabs(),
    标出: await js(`[...${pane}.querySelectorAll('.reader-page mark')].map((m) => m.textContent + (m.classList.contains('current') ? '（当前）' : ''))`),
    提示: await js(`${pane}.querySelector('.find-chip')?.textContent`)
  })
  await shot('q3-reader.png')
  await js(`${pane}.querySelector('.find-chip')?.click()`)
  await wait(300)
  log('下一处', await js(`[...${pane}.querySelectorAll('.reader-page mark')].findIndex((m) => m.classList.contains('current'))`))

  // 文字标签页里按 ⌘F：开一个"全部"，光标在搜索框里
  menu('find')
  await wait(1000)
  log('⌘F', { tabs: await tabs(), 焦点: await js(`document.activeElement?.className`) })
  log('搜「海报」', await search('海报'))
  await shot('q4-find.png')
  await js(`${pane}.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(800)
  log('Esc 清掉', { 搜索框: await js(`${pane}.querySelector('.search-input')?.value`), 数量: await js(`${pane}.querySelector('.toolbar-count')?.textContent`) })
}

/**
 * 文字（设计文档 11.7）：卡片（引文、Markdown）→ 粘贴网页上的一段（格式、来源）→ 文字标签页 →
 * ⌘N 新建、写 Markdown、回到阅读 → 文档：打开 .md、编辑写回文件、撤销 → 下一篇是 GB18030 的 .txt。
 * 来源本来从系统剪贴板读，这里换成固定的网址，不碰真正的剪贴板。
 */
async function textFlow(win: BrowserWindow, { js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const menu = (command: string) => win.webContents.send('menu:command', command)
  const cards = () =>
    js(`[...${pane}.querySelectorAll('.card')].map((c) => {
      const cover = c.querySelector('.cover-quote') ? '引文' : c.querySelector('.cover-md') ? 'Markdown' : c.querySelector('.cover-file') ? '文件' : '其他';
      return cover + ' [' + [...c.querySelectorAll('.badge')].map((b) => b.textContent).join('/') + '] ' + c.querySelector('.card-caption').textContent;
    })`)
  const reader = () =>
    js(`(() => {
      const r = ${pane}.querySelector('.reader');
      if (!r) return null;
      const doc = r.querySelector('.reader-doc');
      return {
        标题栏: r.querySelector('.reader-bar .player-title')?.textContent,
        信息: r.querySelector('.reader-meta')?.textContent,
        排版: doc ? [...new Set([...doc.querySelectorAll('h1,h2,h3,ul,ol,blockquote,table,strong,em,a,code')].map((e) => e.tagName.toLowerCase()))].join(',') : null,
        开头: (doc ?? r.querySelector('.reader-page'))?.textContent.slice(0, 40),
        编辑中: !!r.querySelector('.reader-editor')
      };
    })()`)
  const inspector = () => js(`[...document.querySelectorAll('.inspector .section')].map((s) => s.textContent.trim().slice(0, 60))`)
  const openCard = (name: string) =>
    js(`(() => {
      const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes(${JSON.stringify(name)}));
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return !!card;
    })()`)
  const type = (text: string) =>
    js(`(() => {
      const t = ${pane}.querySelector('.reader-editor');
      if (!t) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)});
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
  const escape = () => js(`${pane}.querySelector('.reader-editor')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  log('点侧栏「文字」', await click('.sidebar .nav-item', '文字'))
  await wait(1200)
  log('文字卡片', await cards())
  await shot('t1-texts.png')

  // 真正读系统剪贴板的那条路走一遍，只看调用不出错（不记录剪贴板里有什么）
  log('读剪贴板来源', await js(`window.bridge.clipboardSource().then(() => '调用成功', (e) => '出错：' + e.message)`))

  // 粘贴网页上的一段：带格式；来源换成固定的网址
  ipcMain.removeHandler('clipboard:source')
  ipcMain.handle('clipboard:source', () => ({ url: 'https://news.example.cn/post/42' }))
  await js(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '为什么要做减法\\n删掉不必要的，剩下的才清楚。\\n参考：极简主义');
    dt.setData('text/html', '<meta charset="utf-8"><h3>为什么要做减法</h3><p>删掉<b>不必要的</b>，剩下的才清楚。</p><p>参考：<a href="https://example.cn/minimal">极简主义</a></p>');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  })()`)
  await wait(1500)
  log('粘贴之后', { 卡片: await cards(), 检查器: await inspector() })
  await shot('t2-pasted.png')

  log('双击粘贴的这段', await openCard('为什么要做减法'))
  await wait(1200)
  log('文字标签页', { tabs: await tabs(), 阅读: await reader() })
  await shot('t3-reader.png')

  // ⌘N：新建一段空白文字，直接编辑
  menu('new')
  await wait(1200)
  log('⌘N', { tabs: await tabs(), 阅读: await reader() })
  log('写', await type('# 随手记\n\n今天看到一张海报，**留白**用得很好。\n\n- 字少\n- 对比强'))
  await wait(1500)
  await escape()
  await wait(800)
  log('写完回到阅读', { tabs: await tabs(), 阅读: await reader() })
  await shot('t4-new.png')

  // 文档：.md 文件
  await key('1', 'meta')
  await wait(600)
  log('点侧栏「文档」', await click('.sidebar .nav-item', '文档'))
  await wait(1200)
  log('文档卡片', await cards())
  await shot('t5-docs.png')
  log('双击读书笔记', await openCard('读书笔记'))
  await wait(1200)
  log('读书笔记', { tabs: await tabs(), 阅读: await reader(), 检查器: await inspector() })
  await shot('t6-doc.png')

  // 编辑文档：写回文件；撤销连文件一起换回来
  await key('e')
  await wait(500)
  const original = (await js(`${pane}.querySelector('.reader-editor')?.value ?? ''`)) as string
  await type(original + '\n## 新加的一节\n\n编辑写回了文件。\n')
  await wait(1500)
  await escape()
  await wait(1200)
  log('编辑后', await reader())
  log('编辑后的正文末尾', await js(`${pane}.querySelector('.reader-doc')?.textContent.slice(-20)`))
  await shot('t7-edited.png')
  menu('undo')
  await wait(1500)
  log('撤销', { 提示: await js(`document.querySelector('.toast')?.textContent ?? null`), 正文末尾: await js(`${pane}.querySelector('.reader-doc')?.textContent.slice(-20)`) })

  // 上一篇：GB18030 的旧文本文件
  await key('ArrowLeft')
  await wait(1200)
  log('上一篇', await reader())
  await shot('t8-gb18030.png')
}

/**
 * 视频的时间段批注（设计文档 11.2）：播放中按 I、O 标出一段，写"运镜很稳 #镜头"；再在时间轴上方拖出一段；
 * 片段的卡片、空格预览循环播这一段；双击片段的卡片：回到播放器，跳到起点。
 */
async function segmentFlow({ js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const video = () =>
    js(`(() => { const v = ${pane}.querySelector('.player-video'); return v ? { paused: v.paused, t: Math.round(v.currentTime * 10) / 10 } : null })()`)
  const lane = () =>
    js(`(() => {
      const l = ${pane}.querySelector('.segment-layer');
      if (!l) return null;
      return {
        提示: l.querySelector('.segment-hint')?.textContent ?? null,
        片段: [...l.querySelectorAll('.segment:not(.draft)')].map((s) => s.className + ' ' + s.style.left + ' ' + s.style.width),
        草稿: l.querySelector('.segment.draft')?.className ?? null,
        选中: l.querySelector('.segment-chip')?.textContent ?? null,
        输入框: l.querySelector('.segment-input')?.textContent ?? null
      };
    })()`)
  const inspector = () => js(`[...document.querySelectorAll('.inspector .section')].map((s) => s.textContent.trim().slice(0, 50))`)
  const typeAndEnter = (text: string) =>
    js(`(() => {
      const input = ${pane}.querySelector('.segment-input input');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`)
  const cardAction = (index: number, dbl: boolean) =>
    js(`(() => {
      const card = ${pane}.querySelectorAll('.card')[${index}];
      if (!card) return false;
      card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      card.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      if (${dbl}) card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`)

  log('点侧栏「视频」', await click('.sidebar .nav-item', '视频'))
  await wait(1500)
  await js(`(() => {
    const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes('分形'));
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`)
  await wait(1500)
  log('打开播放器', { tabs: await tabs(), 播放: await video(), 时间轴上方: await lane(), 检查器: await inspector() })
  await shot('s1-player.png')

  // 边看边标：I 定起点，播一会儿，O 定终点
  await key('i')
  await wait(1200)
  log('按 I 之后', { 播放: await video(), 时间轴上方: await lane() })
  await shot('s2-marking.png')
  await key('o')
  await wait(400)
  log('按 O 之后', { 播放: await video(), 时间轴上方: await lane() })
  await shot('s3-writing.png')
  log('写下', await typeAndEnter('运镜很稳 #镜头'))
  await wait(2000)
  log('写完之后', { 播放: await video(), 时间轴上方: await lane(), 检查器: await inspector() })
  await shot('s4-segment.png')

  // 在时间轴上方拖出一段
  await js(`(() => {
    const l = ${pane}.querySelector('.segment-layer');
    const r = l.getBoundingClientRect();
    const at = (f) => ({ bubbles: true, pointerId: 1, button: 0, clientX: r.left + r.width * f, clientY: r.top + r.height / 2 });
    l.dispatchEvent(new PointerEvent('pointerdown', at(0.7)));
    l.dispatchEvent(new PointerEvent('pointermove', at(0.8)));
    l.dispatchEvent(new PointerEvent('pointermove', at(0.9)));
    l.dispatchEvent(new PointerEvent('pointerup', at(0.9)));
  })()`)
  await wait(400)
  log('拖出一段', { 播放: await video(), 时间轴上方: await lane() })
  log('写下', await typeAndEnter('结尾的颜色变化'))
  await wait(2500)
  log('第二段', { 时间轴上方: await lane() })
  await shot('s5-two.png')

  // 片段自己的卡片
  await key('1', 'meta')
  await wait(600)
  log('点侧栏「批注」', await click('.sidebar .nav-item', '批注'))
  await wait(1500)
  log('批注视图', {
    卡片: await js(`[...${pane}.querySelectorAll('.card')].map((c) => [...c.querySelectorAll('.badge')].map((b) => b.textContent).join('/') + ' ' + c.querySelector('.card-caption').textContent)`),
    封面: await js(`[...${pane}.querySelectorAll('.card')].map((c) => !!c.querySelector('img'))`)
  })
  await shot('s6-cards.png')

  // 空格预览：循环播这一段
  const cards = (await js(`[...${pane}.querySelectorAll('.card')].map((c) => c.querySelector('.card-caption').textContent)`)) as string[]
  const index = cards.findIndex((c) => c.includes('运镜很稳'))
  await cardAction(index, false)
  await wait(300)
  log('检查器（片段）', await inspector())
  await key(' ')
  await wait(1500)
  log('空格预览', await js(`(() => { const v = document.querySelector('.preview video'); return v ? { paused: v.paused, t: Math.round(v.currentTime * 10) / 10 } : null })()`))
  await shot('s7-preview.png')
  await key('Escape')
  await wait(400)

  // 双击片段的卡片：回到播放器，跳到起点
  await cardAction(index, true)
  await wait(1500)
  log('双击片段', { tabs: await tabs(), 播放: await video(), 时间轴上方: await lane() })
  await shot('s8-reveal.png')
  await key('Escape')
  await wait(600)
  log('原视频的检查器', await inspector())
}

/**
 * 局部批注（设计文档 11.2）：双击图片打开查看器 → 拖出一块区域、写"反光处理很好 #光影" →
 * 框、检查器、局部自己的卡片 → 双击局部的卡片：切回查看器并放大到那一块。
 */
async function annotateFlow(win: BrowserWindow, { js, log, shot, click, tabs, key }: Tools & { key(k: string, mods?: string): Promise<unknown> }): Promise<void> {
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const zoomText = () => js(`${pane}.querySelector('.viewer-bar .player-time')?.textContent ?? null`)
  const inspector = () => js(`[...document.querySelectorAll('.inspector .section')].map((s) => s.textContent.trim().slice(0, 40))`)

  log('点侧栏「图片」', await click('.sidebar .nav-item', '图片'))
  await wait(1200)
  await js(`(() => {
    const card = [...${pane}.querySelectorAll('.card')].find((c) => c.querySelector('.card-caption').textContent.includes('作品_24'));
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`)
  await wait(1800)
  log('双击图片', { tabs: await tabs(), 缩放: await zoomText(), 检查器: await inspector() })
  await shot('n1-viewer.png')

  // 拖出一块区域
  await js(`(() => {
    const layer = ${pane}.querySelector('.region-layer');
    const r = layer.getBoundingClientRect();
    const at = (fx, fy) => ({ bubbles: true, pointerId: 1, button: 0, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy });
    layer.dispatchEvent(new PointerEvent('pointerdown', at(0.15, 0.2)));
    layer.dispatchEvent(new PointerEvent('pointermove', at(0.35, 0.4)));
    layer.dispatchEvent(new PointerEvent('pointermove', at(0.5, 0.6)));
    layer.dispatchEvent(new PointerEvent('pointerup', at(0.5, 0.6)));
  })()`)
  await wait(400)
  log('拖出区域后', { 输入框: await js(`!!${pane}.querySelector('.region-input input')`) })
  await js(`(() => {
    const input = ${pane}.querySelector('.region-input input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '反光处理很好 #光影');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await wait(2500)
  log('写下批注后', {
    框: await js(`[...${pane}.querySelectorAll('.region')].map((r) => r.className + ' ' + r.textContent)`),
    检查器: await inspector()
  })
  await shot('n2-annotated.png')

  // 局部自己的卡片：侧栏"批注"
  await key('1', 'meta')
  await wait(600)
  log('点侧栏「批注」', await click('.sidebar .nav-item', '批注'))
  await wait(1500)
  log('批注视图', {
    卡片: await js(`[...${pane}.querySelectorAll('.card')].map((c) => [...c.querySelectorAll('.badge')].map((b) => b.textContent).join('/') + ' ' + c.querySelector('.card-caption').textContent)`),
    封面: await js(`!!${pane}.querySelector('.card img')`),
    标签分面: await js(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find((e) => e.querySelector('.nav-label')?.textContent === '光影'); return b?.querySelector('.nav-count')?.textContent ?? null })()`)
  })
  await shot('n3-local-card.png')

  // 双击局部的卡片：切回原图的查看器，放大到这一块
  await js(`(() => {
    const card = ${pane}.querySelector('.card');
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`)
  await wait(1500)
  log('双击局部', {
    tabs: await tabs(),
    缩放: await zoomText(),
    选中的框: await js(`${pane}.querySelectorAll('.region.selected').length`),
    列表位置: await js(`${pane}.querySelector('.viewer-bar .player-title')?.textContent ?? null`)
  })
  await shot('n4-reveal.png')

  // 取消选中：检查器回到原图，列出它的批注
  await key('Escape')
  await wait(600)
  log('原图的检查器', await inspector())
  await wait(800)
}
