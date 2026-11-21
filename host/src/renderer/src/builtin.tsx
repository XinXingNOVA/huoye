import { uiText } from '../../shared/i18n/interface-display'
import { t, useLanguage } from './language'
import { linkSourceFolder } from './link-source-folder'
import { canOpenCopy } from '../../shared/open-copy'
import { isDirectoryFile } from '../../shared/file-location'
import { wallpaperBlock } from './material-wallpaper'
import { setMaterialWallpaper } from './theme'
import { useSyncExternalStore } from 'react'
import { batchReviewTab } from './tabs/batch-review'
import { historyTabType } from './tabs/history'
import { BUILTIN_LAYOUTS } from './workbench-presets'
import { WorkbenchPresets } from './components/WorkbenchPresets'
import { ItemDisposalDialog } from './components/ItemDisposalDialog'
import { fileSpacesTabType } from './tabs/file-spaces'
import { FileStorageDialog } from './components/FileStorageDialog'
// 宿主内置的界面部分：集合标签页、瀑布流布局、"全部"与"回收站"两个预设视图、
// 右键菜单里的通用操作（打开、附加、导出、移到回收站、恢复、彻底删除）。和插件走同一套扩展点。

import type { EntityView } from '../../shared/blocks'
import { Grid } from './components/Grid'
import { FolderSpaceIcon, PresetViewIcon, SparklesIcon, TabTypeIcon } from './components/icons'
import type { NavProps, UiPlugin, TabProps } from './plugin'
import { collectionTabType } from './tabs/collection'
import { dataTabType } from './tabs/data'
import { managementTabType } from './tabs/management'
import { acceleratorLabel } from './widgets'

const ids = (vs: EntityView[]) => vs.map((v) => v.id)
const live = (vs: EntityView[]) => vs.every((v) => !v.deletedAt)
const trashed = (vs: EntityView[]) => vs.every((v) => v.deletedAt)
const one = (vs: EntityView[]) => vs.length === 1

function StartPage({ host }: TabProps) {
  useLanguage()
  const presetSnap = useSyncExternalStore(host.workbenchPresets.subscribe, host.workbenchPresets.getSnapshot)
  const quickPresets = presetSnap.presets.slice(0, 5)
  const triggerImport = () => {
    const session = host.commands.createSession({ ids: ['host.library.import'] })
    void session
      .execute('host.library.import')
      .catch((e: unknown) => host.notify(e instanceof Error ? e.message : String(e)))
      .finally(() => session.dispose())
  }
  return (
    <div className="editor-start">
      <div className="editor-start-shell">
        <div className="editor-start-hero">
          <div className="editor-start-badge" aria-hidden="true">
            <SparklesIcon size={22} />
          </div>
          <h2>{t('start.open')}</h2>
          <p>{t('start.hint')}</p>
        </div>

        <div className="editor-start-grid">
          <button
            className="editor-start-card primary-start-card"
            onClick={() => host.openTab('collection', { title: uiText("全部"), query: { scope: 'content' }, presetId: 'all' })}
          >
            <div className="editor-start-card-icon">
              <PresetViewIcon id="all" />
            </div>
            <div className="editor-start-card-body">
              <strong>{t('start.browse')}</strong>
              <span>{t('start.browseHint')}</span>
            </div>
          </button>

          <button
            className="editor-start-card"
            onClick={() => void linkSourceFolder(host)}
          >
            <div className="editor-start-card-icon">
              <FolderSpaceIcon size={15} />
            </div>
            <div className="editor-start-card-body">
              <strong>{t('common.link')}</strong>
              <span>{t('start.linkHint')}</span>
            </div>
          </button>

          <button
            className="editor-start-card"
            onClick={triggerImport}
          >
            <div className="editor-start-card-icon">
              <TabTypeIcon type="collection" params={{ presetId: 'unorganized' }} />
            </div>
            <div className="editor-start-card-body">
              <strong>{t('start.import')}</strong>
              <span>{t('start.importHint')}</span>
            </div>
          </button>

          <button
            className="editor-start-card"
            onClick={() => host.openTab('history', {})}
          >
            <div className="editor-start-card-icon">
              <TabTypeIcon type="history" />
            </div>
            <div className="editor-start-card-body">
              <strong>{t('start.history')}</strong>
              <span>{t('start.historyHint')}</span>
            </div>
          </button>
        </div>

        <div className="editor-start-presets">
          <span className="muted editor-start-presets-label">{t('start.presets')}</span>
          <div className="editor-start-presets-pills">
            {quickPresets.map(p => (
              <button
                key={p.id}
                type="button"
                className="small editor-start-preset-pill"
                title={p.description}
                onClick={() => {
                  try { host.workbenchPresets.apply(p.id) }
                  catch (e) { host.notify(e instanceof Error ? e.message : String(e)) }
                }}
              >
                {p.title}
              </button>
            ))}
            {presetSnap.canReturn && (
              <button
                type="button"
                className="small editor-start-preset-pill"
                onClick={() => {
                  try { host.workbenchPresets.back() }
                  catch (e) { host.notify(e instanceof Error ? e.message : String(e)) }
                }}
              >
                {t('start.back')}
              </button>
            )}
            <button
              type="button"
              className="small editor-start-preset-pill"
              onClick={() => host.openWorkbenchPresets('manage')}
            >
              {t('start.manage')}
            </button>
          </div>
        </div>

        <div className="editor-start-shortcuts muted">
          <span><kbd>{acceleratorLabel('CmdOrCtrl+P')}</kbd> {t('start.commands')}</span>
          <span><kbd>{acceleratorLabel('CmdOrCtrl+,')}</kbd> {t('start.preferences')}</span>
          <span><kbd>Space</kbd> {t('start.preview')}</span>
          <span>{t('start.split')}</span>
        </div>
      </div>
    </div>
  )
}
function FileSpacesNav({ host }: NavProps) {
  useLanguage()
  return (
    <button className="nav-item" onClick={() => host.openTab('file-spaces', {})}>
      <FolderSpaceIcon size={14} className="nav-item-icon" />
      <span className="nav-label">{t('common.fileSpaces')}</span>
    </button>
  )
}

export const builtinUi: UiPlugin = {
  id: 'host',
  workbenchPresets: [...BUILTIN_LAYOUTS],
  workbenchPresetUis: [{ id: 'host.presets', priority: 1000, Component: WorkbenchPresets }],
  views: [
    { id: 'all', title: '全部', query: { scope: 'content' }, order: 0 },
    { id: 'records', title: '插件管理数据', query: { scope: 'all', role: 'management' }, tab: 'management', defaultVisible: false, order: 900 },
    { id: 'trash', title: '回收站', query: { scope: 'trash' }, order: 1000 }
  ],
  navs: [{ id: 'file-spaces', Component: FileSpacesNav, order: 800 }],
  tabTypes: [{ id: 'workspace.start', Title: () => <>{uiText("开始")}</>, Component: StartPage }, historyTabType, batchReviewTab, fileSpacesTabType, collectionTabType, dataTabType, managementTabType],
  layouts: [{ id: 'masonry', session: true, get title() { return t('workbench.masonry') }, get description() { return t('display.masonryHint') }, size: { get label() { return t('display.cardSize') }, min: 120, max: 480, step: 10, default: 220 }, Component: Grid }],
  actions: [
    { id: 'file.edit', group: 10, order: 0.8, title: () => t('itemAction.edit'), when: vs => one(vs) && live(vs) && !!vs[0].blocks.file && !isDirectoryFile(vs[0].blocks.file?.data.path), run: ([v], host) => host.editFile(v.id) },
    { id: 'file.open-original', group: 10, order: 0.8, title: () => t('itemAction.original'), when: vs => one(vs) && live(vs) && isDirectoryFile(vs[0].blocks.file?.data.path) && canOpenCopy(vs[0].blocks.file?.data.path), run: ([v]) => window.bridge.files.openOriginal(v.id) },
    { id: 'file.managed-copy', group: 30, order: 2.9, title: () => t('itemAction.manage'), when: vs => one(vs) && live(vs) && isDirectoryFile(vs[0].blocks.file?.data.path), run: ([v], host) => host.showDialog(close => <FileStorageDialog id={v.id} host={host} close={close}/>) },
    { id: 'file.storage', icon: 'tool', group: 30, order: 3, title: () => t('itemAction.storage'), when: vs => one(vs) && !!vs[0].blocks.file, run: ([v], host) => host.showDialog(close => <FileStorageDialog id={v.id} host={host} close={close} />) },
    { id: 'open', includeContainers: true, inspector: 'primary', group: 10, order: 0, title: () => t('common.open'), when: one, run: ([v], host) => host.open(v.id) },
    { id: 'open.other', includeContainers: true, inspector: 'shortcut', icon: 'split', group: 10, order: 0.5, title: () => t('itemAction.other'), when: one, run: ([v], host) => host.open(v.id, undefined, { group: 'other' }) },
    { id: 'host.wallpaper', group: 40, order: 10, title: () => t('itemAction.wallpaper'), when: vs => one(vs) && !!wallpaperBlock(vs[0]),
      run: async ([v], host) => { await setMaterialWallpaper(v.id); host.notify(uiText("已设为本库壁纸")) } },
    { id: 'open.with', includeContainers: true, group: 10, order: 0.7, title: () => t('itemAction.choose'), when: vs => one(vs) && live(vs), run: ([v], host) => host.open(v.id, undefined, { opener: 'host.choose' }) },
    { id: 'preview', includeContainers: true, group: 10, order: 1, title: () => t('itemAction.preview'), accelerator: 'Space', when: one, run: ([v], host) => host.preview(v.id) },
    { id: 'data.details', includeContainers: true, group: 10, order: 2, title: () => t('itemAction.details'), when: one, run: ([v], host) => host.openData(v.id) },
    { id: 'data.takeout', includeContainers: true, group: 30, order: 1, title: () => t('itemAction.takeout'), run: (vs, host) => host.takeout(ids(vs), vs.length === 1 ? host.title(vs[0]) : uiText("{length} 项记录", { length: String(vs.length) })) },
    { id: 'attach', inspector: 'shortcut', icon: 'plus', group: 20, order: 0, title: () => t('itemAction.attach'), accelerator: 'A', when: live, run: (vs, host) => host.quickAttach(ids(vs)) },
    {
      id: 'export', includeContainers: true, inspector: 'primary',
      group: 30,
      order: 0,
      title: (vs) => (vs.length > 1 ? t('itemAction.exportMany', { count: vs.length }) : t('menu.export')),
      accelerator: 'Shift+CmdOrCtrl+E',
      when: live,
      run: (vs, host) => {
        const date = new Date().toISOString().slice(0, 10)
        host.export(ids(vs), vs.length === 1 ? host.title(vs[0]) : uiText("{length} 项 {date}", { length: String(vs.length), date }))
      }
    },
    { id: 'trash', includeContainers: true, group: 90, order: 0, title: () => t('itemAction.trash'), accelerator: 'CmdOrCtrl+Backspace', danger: true, when: live, run: (vs, host) => host.trash(ids(vs)) },
    { id: 'trash.originals', group: 90, order: 1, title: () => t('itemAction.trashOriginals'), danger: true, when: vs => vs.length > 0,
      run: (vs, host) => host.showDialog(close => <ItemDisposalDialog ids={ids(vs)} onClose={close} />) },
    { id: 'restore', includeContainers: true, inspector: 'primary', group: 90, order: 0, title: () => t('itemAction.restore'), when: trashed, run: (vs, host) => void host.core.restore(ids(vs)) },
    { id: 'purge', includeContainers: true, group: 90, order: 1, title: () => t('itemAction.remove'), accelerator: 'CmdOrCtrl+Backspace', danger: true, when: trashed, run: (vs, host) => host.purge(ids(vs)) }
  ]
}
