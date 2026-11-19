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
          <h2>打开内容</h2>
          <p>把标签拖到这里，或从素材列表选择内容打开。</p>
        </div>

        <div className="editor-start-grid">
          <button
            className="editor-start-card primary-start-card"
            onClick={() => host.openTab('collection', { title: '全部', query: { scope: 'content' }, presetId: 'all' })}
          >
            <div className="editor-start-card-icon">
              <PresetViewIcon id="all" />
            </div>
            <div className="editor-start-card-body">
              <strong>浏览全部素材</strong>
              <span>打开瀑布流画布，按标签或类型检索素材</span>
            </div>
          </button>

          <button
            className="editor-start-card"
            onClick={() => host.openTab('file-spaces', {})}
          >
            <div className="editor-start-card-icon">
              <FolderSpaceIcon size={15} />
            </div>
            <div className="editor-start-card-body">
              <strong>文件空间工作台</strong>
              <span>管理独享与共享目录、收录策略与原件版本</span>
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
              <strong>导入本地文件…</strong>
              <span>从系统选择文件或文件夹收录进当前仓库</span>
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
              <strong>操作历史与恢复</strong>
              <span>查看本次会话的修改记录，按序撤销或重做</span>
            </div>
          </button>
        </div>

        <div className="editor-start-presets">
          <span className="muted editor-start-presets-label">工作台预设：</span>
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
                ↩ 返回切换前
              </button>
            )}
            <button
              type="button"
              className="small editor-start-preset-pill"
              onClick={() => host.openWorkbenchPresets('manage')}
            >
              管理预设…
            </button>
          </div>
        </div>

        <div className="editor-start-shortcuts muted">
          <span><kbd>{acceleratorLabel('CmdOrCtrl+P')}</kbd> 命令与搜索</span>
          <span><kbd>{acceleratorLabel('CmdOrCtrl+,')}</kbd> 偏好设置</span>
          <span><kbd>Space</kbd> 快速预览</span>
          <span>拖拽标签页至边缘即可分屏并排</span>
        </div>
      </div>
    </div>
  )
}
function FileSpacesNav({ host }: NavProps) {
  return (
    <button className="nav-item" onClick={() => host.openTab('file-spaces', {})}>
      <FolderSpaceIcon size={14} className="nav-item-icon" />
      <span className="nav-label">文件空间</span>
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
  tabTypes: [{ id: 'workspace.start', Title: () => <>开始</>, Component: StartPage }, historyTabType, batchReviewTab, fileSpacesTabType, collectionTabType, dataTabType, managementTabType],
  layouts: [{ id: 'masonry', session: true, title: '瀑布流', description: '按原始比例排列封面，适合浏览图片和混合素材。', size: { label: '卡片大小', min: 120, max: 480, step: 10, default: 220 }, Component: Grid }],
  actions: [
    { id: 'file.edit', group: 10, order: 0.8, title: '编辑文件', when: vs => one(vs) && live(vs) && !!vs[0].blocks.file, run: ([v], host) => host.editFile(v.id) },
    { id: 'file.storage', icon: 'tool', group: 30, order: 3, title: '文件存储…', when: vs => one(vs) && !!vs[0].blocks.file, run: ([v], host) => host.showDialog(close => <FileStorageDialog id={v.id} host={host} close={close} />) },
    { id: 'open', includeContainers: true, inspector: 'primary', group: 10, order: 0, title: '打开', when: one, run: ([v], host) => host.open(v.id) },
    { id: 'open.other', includeContainers: true, inspector: 'shortcut', icon: 'split', group: 10, order: 0.5, title: '在另一组打开', when: one, run: ([v], host) => host.open(v.id, undefined, { group: 'other' }) },
    { id: 'open.with', includeContainers: true, group: 10, order: 0.7, title: '打开方式…', when: vs => one(vs) && live(vs), run: ([v], host) => host.open(v.id, undefined, { opener: 'host.choose' }) },
    { id: 'preview', includeContainers: true, group: 10, order: 1, title: '预览', accelerator: 'Space', when: one, run: ([v], host) => host.preview(v.id) },
    { id: 'data.details', includeContainers: true, group: 10, order: 2, title: '数据详情', when: one, run: ([v], host) => host.openData(v.id) },
    { id: 'data.takeout', includeContainers: true, group: 30, order: 1, title: '取回数据…', run: (vs, host) => host.takeout(ids(vs), vs.length === 1 ? host.title(vs[0]) : `${vs.length} 项记录`) },
    { id: 'attach', inspector: 'shortcut', icon: 'plus', group: 20, order: 0, title: '附加…', accelerator: 'A', when: live, run: (vs, host) => host.quickAttach(ids(vs)) },
    {
      id: 'export', includeContainers: true, inspector: 'primary',
      group: 30,
      order: 0,
      title: (vs) => (vs.length > 1 ? `导出 ${vs.length} 项…` : '导出…'),
      accelerator: 'Shift+CmdOrCtrl+E',
      when: live,
      run: (vs, host) => {
        const date = new Date().toISOString().slice(0, 10)
        host.export(ids(vs), vs.length === 1 ? host.title(vs[0]) : `${vs.length} 项 ${date}`)
      }
    },
    { id: 'trash', includeContainers: true, group: 90, order: 0, title: '移到仓库回收站', accelerator: 'CmdOrCtrl+Backspace', danger: true, when: live, run: (vs, host) => host.trash(ids(vs)) },
    { id: 'trash.originals', group: 90, order: 1, title: '连同原件移到系统废纸篓…', danger: true, when: vs => vs.length > 0,
      run: (vs, host) => host.showDialog(close => <ItemDisposalDialog ids={ids(vs)} onClose={close} />) },
    { id: 'restore', includeContainers: true, inspector: 'primary', group: 90, order: 0, title: '恢复', when: trashed, run: (vs, host) => void host.core.restore(ids(vs)) },
    { id: 'purge', includeContainers: true, group: 90, order: 1, title: '彻底删除素材记录…', accelerator: 'CmdOrCtrl+Backspace', danger: true, when: trashed, run: (vs, host) => host.purge(ids(vs)) }
  ]
}
