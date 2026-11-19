import { Component, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type {
  PresetInfo,
  ReadonlyPresetValue,
  WorkbenchNode,
  WorkbenchPresetUi,
  WorkbenchPresetUiProps
} from '../../../plugin-api/ui/workbench-presets'
import { PresetMiniGlyph } from './PresetMiniGlyph'
import { WorkbenchPresetPreview } from './WorkbenchPresetPreview'
import './workbench-presets.css'

type Row = ReadonlyPresetValue<PresetInfo>
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
const descriptions: Record<string, string> = {
  'host.organize': '单区域，展开两侧栏',
  'host.focus': '单区域，收起两侧栏',
  'host.compare': '左右对照，收起两侧栏'
}
const groups = (node: WorkbenchNode): number =>
  node.type === 'group' ? 1 : groups(node.first) + groups(node.second)
const summary = (p: Row) =>
  p.description ??
  descriptions[p.id] ??
  `${groups(p.layout.root)} 个区域 · ${p.layout.panels.sidebar ? '展开' : '收起'}左栏 · ${p.layout.panels.inspector ? '展开' : '收起'}右栏`

/** 这里保护管理界面的渲染失败；服务和当前布局不受影响，直接回到默认界面。 */
class PresetBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    console.error('预设管理界面失败', error)
  }
  render() {
    return this.state.failed ? (
      <>
        <p role="alert">预设界面出错，已使用基础界面；已有预设和布局保留。</p>
        {this.props.fallback}
      </>
    ) : (
      this.props.children
    )
  }
}

export function WorkbenchPresetDialog({
  provider,
  ...props
}: WorkbenchPresetUiProps & { provider?: WorkbenchPresetUi }) {
  const View = provider?.Component ?? WorkbenchPresets
  return (
    <PresetBoundary key={provider?.id} fallback={<WorkbenchPresets {...props} />}>
      <View {...props} />
    </PresetBoundary>
  )
}

/** 默认界面也只使用公共契约，可整体换成外部插件。 */
export function WorkbenchPresets({ host, close, intent }: WorkbenchPresetUiProps) {
  const service = host.workbenchPresets
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot)
  const [selected, setSelected] = useState(() =>
    intent === 'save' ? 'current' : (snapshot.presets[0]?.id ?? 'current')
  )
  const [search, setSearch] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ action: 'new' | 'copy' | 'rename'; id?: string } | undefined>(
    intent === 'save' ? { action: 'new' } : undefined
  )
  const [confirm, setConfirm] = useState<'update' | 'remove'>()
  const row = snapshot.presets.find(p => p.id === selected),
    current = selected === 'current'
  const problem = snapshot.catalogError,
    canSave = !problem && !!snapshot.current
  const layout = current || confirm === 'update' ? snapshot.current : row?.layout
  const duplicate = snapshot.presets.some(
    p => p.editable && p.title === name.trim() && !(editing?.action === 'rename' && editing.id === p.id)
  )
  const select = (id: string) => {
    setSelected(id)
    setEditing(undefined)
    setConfirm(undefined)
    setError('')
    setNotice('')
  }
  const begin = (action: 'new' | 'copy' | 'rename') => {
    setEditing({ action, id: row?.id })
    setConfirm(undefined)
    setError('')
    setNotice('')
    setName(action === 'new' ? '' : action === 'copy' ? row!.title + ' 副本' : row!.title)
    if (action === 'new') setSelected('current')
  }
  const perform = (fn: () => void, message: string) => {
    try {
      fn()
      setError('')
      setNotice(message)
      setEditing(undefined)
      setConfirm(undefined)
    } catch (e) {
      setError(reason(e))
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!editing || !name.trim() || duplicate || problem) return
    if (editing.action === 'new')
      perform(() => {
        setSelected(service.saveCurrent(name))
        setSearch('')
      }, '已保存当前工作台')
    else if (editing.action === 'copy')
      perform(() => {
        setSelected(service.copy(editing.id!, name))
        setSearch('')
      }, '已另存为自己的预设')
    else perform(() => service.rename(editing.id!, name), '名称已更新')
  }
  const sources = [
    { kind: 'scheme', title: '方案附带' },
    { kind: 'user', title: '我的预设' },
    { kind: 'plugin', title: '插件提供' },
    { kind: 'builtin', title: '应用附带' }
  ] as const

  const filteredGroups = sources
    .map(source => ({
      ...source,
      rows: snapshot.presets.filter(
        p =>
          p.source.kind === source.kind &&
          `${p.title} ${p.description ?? ''} ${'title' in p.source ? p.source.title : ''}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase().trim())
      )
    }))
    .filter(g => g.rows.length > 0)

  const liveSummary = snapshot.current
    ? `${groups(snapshot.current.root)} 个中央分区 · 左栏${snapshot.current.panels.sidebar ? '展开' : '收起'} · 右栏${snapshot.current.panels.inspector ? '展开' : '收起'}`
    : '当前布局只读预览'

  return (
    <section className="workbench-presets" aria-label="布局预设">
      <header>
        <div>
          <h2>工作台预设</h2>
          <p className="muted">切换分区结构、侧栏工具组合与默认功能页面（保留已打开的文档与草稿）</p>
        </div>
        <button className="small" aria-label="关闭布局预设" onClick={close}>
          关闭
        </button>
      </header>

      {(error || problem) && (
        <p className="workbench-preset-error" role="alert">
          {error || problem}
          {problem ? '。已有预设未被改写；仍可使用附带布局。' : ''}
        </p>
      )}
      {snapshot.currentError && (
        <p className="workbench-preset-error" role="alert">
          {snapshot.currentError}
        </p>
      )}

      <div className={`workbench-live-bar${current ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="workbench-live-bar-main"
          aria-pressed={current}
          onClick={() => select('current')}
        >
          <span className="workbench-live-dot" aria-hidden="true" />
          <strong>当前工作台现场</strong>
          <span className="muted">{liveSummary}</span>
        </button>
        <div className="workbench-preset-actions">
          {snapshot.canReturn && (
            <button
              className="small"
              onClick={() =>
                perform(() => {
                  service.back()
                  close()
                }, '')
              }
            >
              返回切换前布局
            </button>
          )}
          <button className="small primary" disabled={!canSave} onClick={() => begin('new')}>
            保存当前布局…
          </button>
        </div>
      </div>

      <div className="workbench-preset-browser">
        <nav className="workbench-preset-catalog" aria-label="预设列表">
          <input
            className="field-text"
            aria-label="搜索预设"
            placeholder="搜索预设…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {filteredGroups.map(source => (
            <section key={source.kind}>
              <h3>
                <span>{source.title}</span>
                <small>{source.rows.length}</small>
              </h3>
              {source.rows.map(p => (
                <button
                  key={p.id}
                  className="workbench-preset-choice"
                  data-layout-preset={p.id}
                  aria-pressed={selected === p.id}
                  onClick={() => select(p.id)}
                >
                  <div className="workbench-preset-choice-row">
                    <PresetMiniGlyph layout={p.layout} size="sm" />
                    <div className="workbench-preset-choice-text">
                      <strong>{p.title}</strong>
                      <span>{summary(p)}</span>
                    </div>
                  </div>
                  {!!(p.issues?.length || p.missingViews.length) && (
                    <span className="workbench-preset-choice-warn">
                      有 {p.issues?.length || p.missingViews.length} 项内容暂不可用
                    </span>
                  )}
                </button>
              ))}
            </section>
          ))}
          {!filteredGroups.length && (
            <p className="muted">{search.trim() ? '无匹配预设' : '暂无预设'}</p>
          )}
        </nav>

        <div key={selected} className="workbench-preset-detail">
          <div className="workbench-preset-heading">
            <div>
              <h3>{current ? '当前工作台现场' : (row?.title ?? '预设已不可用')}</h3>
              {row?.description && <p className="muted">{row.description}</p>}
            </div>
            <div className="workbench-preset-head-right">
              <span className="workbench-preset-source-pill">
                {row && 'title' in row.source
                  ? row.source.title
                  : row && !row.editable
                    ? '只读原版'
                    : '本机 · 当前仓库'}
              </span>
              {!editing && !confirm && !current && row && (
                <div className="workbench-preset-actions">
                  <button
                    className="small primary"
                    onClick={() =>
                      perform(() => {
                        service.apply(row.id)
                        close()
                      }, '')
                    }
                  >
                    应用预设
                  </button>
                  <button className="small" disabled={!!problem} onClick={() => begin('copy')}>
                    另存副本
                  </button>
                  {row.editable && (
                    <>
                      <button className="small" disabled={!!problem} onClick={() => begin('rename')}>
                        重命名
                      </button>
                      <button className="small" disabled={!canSave} onClick={() => setConfirm('update')}>
                        更新为当前布局
                      </button>
                      <button className="small" disabled={!!problem} onClick={() => setConfirm('remove')}>
                        删除
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {editing && (
            <form className="workbench-preset-form" onSubmit={submit}>
              <label htmlFor="workbench-preset-name">
                {editing.action === 'rename' ? '重命名' : '预设名称'}
              </label>
              <input
                key={editing.action + editing.id}
                id="workbench-preset-name"
                className="field-text"
                autoFocus
                value={name}
                maxLength={80}
                placeholder="例如：阅读与对照"
                aria-invalid={duplicate}
                aria-describedby={duplicate ? 'preset-name-error' : undefined}
                onChange={e => setName(e.target.value)}
                disabled={!!problem}
              />
              {duplicate && (
                <p id="preset-name-error" className="workbench-preset-error">
                  已有同名预设，请换一个名称
                </p>
              )}
              <div>
                <button type="button" className="small" onClick={() => setEditing(undefined)}>
                  取消
                </button>
                <button
                  className="primary"
                  disabled={
                    !name.trim() ||
                    duplicate ||
                    !!problem ||
                    (editing.action === 'new' && !snapshot.current)
                  }
                  type="submit"
                >
                  {editing.action === 'rename' ? '保存名称' : '保存布局'}
                </button>
              </div>
            </form>
          )}

          {confirm && row && (
            <div className="workbench-preset-confirm">
              <p>
                {confirm === 'remove'
                  ? '删除这个预设？当前工作台保持原样。'
                  : '用下方当前工作台的编排覆盖这个预设？原预设的编排会被替换。'}
              </p>
              <div>
                <button className="small" onClick={() => setConfirm(undefined)}>
                  取消
                </button>
                <button
                  className={confirm === 'remove' ? 'danger' : 'primary'}
                  disabled={!!problem || (confirm === 'update' && !canSave)}
                  onClick={() =>
                    confirm === 'remove'
                      ? perform(() => {
                          service.remove(row.id)
                          setSelected(service.getSnapshot().presets[0]?.id ?? 'current')
                        }, '预设已删除')
                      : perform(() => service.updateFromCurrent(row.id), '预设已更新')
                  }
                >
                  {confirm === 'remove' ? '删除预设' : '更新布局'}
                </button>
              </div>
            </div>
          )}

          {layout && <WorkbenchPresetPreview layout={layout} service={service} />}

          {current || confirm === 'update' ? (
            <p className="preset-scope muted">
              保存分区、侧栏工具与支持的功能页及显示配置。具体文档、保存视图、固定绑定、草稿和临时筛选留在当前工作区，不写入预设。
            </p>
          ) : (
            row && (
              <p className="preset-scope muted">
                应用时保留已打开的页面与草稿；复用已有功能页，新分区按预设补充内容。可返回上次切换前的布局。
              </p>
            )
          )}
        </div>
      </div>

      {notice && (
        <footer>
          <span role="status" className="muted">
            {notice}
          </span>
        </footer>
      )}
    </section>
  )
}
