import { readWorkbenchLayout } from '../../../shared/workbench-layout'
import type { WorkbenchPresetService } from '../../../plugin-api/ui/workbench-presets'
import { WorkbenchPresetPreview } from './WorkbenchPresetPreview'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  PluginPreset,
  PluginPresetMode,
  PluginPresetPreview,
  PluginPresetService,
  PluginSelection,
  PresetArrangement,
  PendingPresetArrangement
} from '../../../plugin-api/ui/plugin-presets'
import type { SettingsService } from '../../../plugin-api/ui/settings'
import { SectionHeader } from './ui-primitives'
import './plugin-presets.css'

interface Props {
  active: boolean
  settings?: SettingsService
  workbench: WorkbenchPresetService
  requested?: { id: string; nonce: number }
  api: PluginPresetService
  selection: PluginSelection
  busy: boolean
  dirty: boolean
  development: string[]
  onActivity(busy: boolean): void
  onUse(preview: PluginPresetPreview, arrangement?: PresetArrangement): Promise<void>
}

export function PluginPresets({
  active,
  settings,
  workbench,
  requested,
  api,
  selection,
  busy,
  dirty,
  development,
  onUse,
  onActivity
}: Props) {
  const [presets, setPresets] = useState<PluginPreset[]>([]), [id, setId] = useState('')
  const [mode, setMode] = useState<PluginPresetMode>('add')
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<'save' | 'copy' | 'rename' | 'update' | 'remove'>(), [name, setName] = useState('')
  const [versions, setVersions] = useState<PluginSelection['external']>()
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [withLayout, setWithLayout] = useState(true), [captureLayout, setCaptureLayout] = useState(false)
  const [removeLayout, setRemoveLayout] = useState(false)
  const [recovery, setRecovery] = useState<PendingPresetArrangement>()
  const handledRequest = useRef<number>(undefined)

  useEffect(() => {
    if (!requested || handledRequest.current === requested.nonce) return
    if (editor) {
      setNotice('请先保存或取消当前组合编辑，再预览所选方案。')
      return
    }
    handledRequest.current = requested.nonce
    setId(requested.id)
    setVersions(undefined)
    setVersionsOpen(false)
    setAttempt(n => n + 1)
    setWithLayout(true)
    setNotice('')
  }, [requested, editor])

  const editingPreset = useRef<PluginPreset>(undefined)
  const selected = presets.find(p => p.id === id)
  const query = useMemo(() => active && selected && !editor
    ? { preset: selected, mode, selection, versions, attempt }
    : undefined, [active, selected, editor, mode, selection, versions, attempt])
  const [preview, setPreview] = useState<{ query: NonNullable<typeof query>; value?: PluginPresetPreview; error?: string }>()
  const currentPreview = preview && preview.query === query ? preview : undefined
  const shown = currentPreview?.value
  const changes = (shown?.changes ?? []).map(change => {
    const wasEnabled = selection.external.some(p => p.id === change.id && p.enabled)
    const action = !change.enabled ? '停用' : wasEnabled ? '切换版本' : '启用'
    return { ...change, action }
  })
  const changeSummary = ['启用', '停用', '切换版本'].flatMap(action => {
    const count = changes.filter(c => c.action === action).length
    return count ? [`${action} ${count} 项`] : []
  }).join('、')
  const versionRows = shown?.versions ?? []
  const needsChoice = (row: typeof versionRows[number]) => !row.choices.some(c => c.hash === row.selected)
  const requiredVersions = versionRows.filter(needsChoice)
  const otherVersions = versionRows.filter(row => row.choices.length > 1 && !needsChoice(row))
  const disabled = busy || pending
  const formState = useRef({ dirty: false, busy: false })
  formState.current = { dirty: !!editor, busy: pending }

  useEffect(
    () =>
      settings?.registerGuard('host.plugin-preset-editor', {
        state: () => ({ ...formState.current, message: '请先保存或取消插件组合编辑' }),
        beforeLeave: intent => intent.reason === 'navigate'
      }),
    [settings]
  )

  useEffect(() => {
    let alive = true, sequence = 0
    const load = async () => {
      const next = ++sequence
      try {
        const [values, job] = await Promise.all([api.list(), api.pending()])
        if (alive && next === sequence) {
          setPresets(values)
          setRecovery(job)
        }
      } catch (e) {
        if (alive && next === sequence) setError(String(e))
      }
    }
    void load()
    const off = api.onChanged(() => {
      void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [api])

  const run = async (action: () => Promise<void>) => {
    setPending(true)
    onActivity(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
      onActivity(false)
    }
  }

  useEffect(() => {
    if (!query) return
    let current = true
    void api.preview(query.preset.id, query.mode, query.selection, query.versions).then(
      value => { if (current) setPreview({ query, value }) },
      e => { if (current) setPreview({ query, error: e instanceof Error ? e.message : String(e) }) }
    )
    return () => { current = false }
  }, [api, query])

  const selectPreset = (next: string) => {
    if (disabled) return
    if (editor) { setNotice('请先保存或取消当前组合编辑，再切换方案。'); return }
    setId(next)
    setVersions(undefined)
    setVersionsOpen(false)
    setAttempt(n => n + 1)
    setWithLayout(true)
    setError('')
    setNotice('')
  }

  const edit = (action: typeof editor) => {
    editingPreset.current = selected
    setEditor(action)
    setName(
      action === 'rename'
        ? selected?.title ?? ''
        : action === 'copy'
          ? `${selected?.title ?? ''} 副本`
          : ''
    )
    setCaptureLayout(false)
    setRemoveLayout(false)
    setError('')
    setNotice('')
    setPreview(undefined)
  }

  const save = async () =>
    run(async () => {
      const current = captureLayout ? workbench.getSnapshot().current : undefined
      if (captureLayout && !current) throw new Error('当前工作台无法保存为安排')
      const options = captureLayout
        ? { layout: readWorkbenchLayout(current) }
        : removeLayout
          ? { layout: null }
          : undefined
      if (editor === 'save') {
        const p = await api.save(name, selection, options)
        setId(p.id)
      } else if (editor === 'copy' && editingPreset.current) {
        const p = await api.copy(editingPreset.current.id, name)
        setId(p.id)
      } else if (editingPreset.current) {
        const selected = editingPreset.current
        if (editor === 'rename') await api.rename(selected.id, selected.revision, name)
        if (editor === 'update') await api.update(selected.id, selected.revision, selection, options)
        if (editor === 'remove') {
          await api.remove(selected.id, selected.revision)
          setId('')
        }
      }
      setVersions(undefined)
      setVersionsOpen(false)
      setPresets(await api.list())
      setEditor(undefined)
      setNotice(editor === 'remove' ? '组合已删除。' : '组合已保存。')
    })

  const versionPicker = (row: typeof versionRows[number]) => (
    <label className="starting-version" key={row.id}>
      <span>{row.title}</span>
      <select data-plugin-version={row.id} aria-label={row.title + '使用版本'} disabled={disabled}
        value={needsChoice(row) ? '' : row.selected} onChange={e => {
          const hash = e.target.value
          setVersions(previous => [...(previous ?? []).filter(v => v.id !== row.id), { id: row.id, hash, enabled: true }])
        }}>
        <option value="" disabled>选择已安装版本</option>
        {row.choices.map(c => <option key={c.hash} value={c.hash}>{c.version}{c.hash === row.recommended ? ' · 推荐' : ''}{selection.external.some(v => v.id === row.id && v.hash === c.hash) ? ' · 当前' : ''}</option>)}
      </select>
    </label>
  )
  return (
    <section className="plugin-presets" aria-label="插件组合">
      <SectionHeader
        title="可用方案"
        badge={presets.length ? `${presets.length} 个方案` : undefined}
        actions={
          <button className="small primary" disabled={disabled || !!editor} onClick={() => edit('save')}>
            保存当前选择…
          </button>
        }
      />

      {recovery && (
        <div className="plugin-presets-preview plugin-presets-recovery" role="status">
          <div className="plugin-presets-recovery-main">
            <strong>待完成：{recovery.title} 的工作台安排</strong>
            <p className="muted">
              {recovery.problem ?? '插件选择已保存；布局将在工作台就绪后应用。保存失败时可重试。'}
            </p>
          </div>
          <div className="plugin-presets-actions">
            <button
              className="small primary"
              disabled={disabled || !!recovery.problem}
              onClick={() => void run(() => api.retryPending(recovery.id))}
            >
              重试布局
            </button>
            <button
              className="small"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await api.cancelPending(recovery.id)
                  setRecovery(undefined)
                })
              }
            >
              取消接续
            </button>
          </div>
        </div>
      )}

      {development.length > 0 && (
        <p className="muted">开发插件单独管理，不计入组合：{development.join('、')}</p>
      )}

      {presets.length > 0 && (
        <div className="plugin-preset-gallery" role="group" aria-label="可用方案卡片">
          {presets.map(p => {
            const active = p.id === id
            const suiteTitle = p.source?.kind === 'suite' ? p.source.title : undefined
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                data-preset-id={p.id}
                className={`plugin-preset-card${active ? ' is-selected' : ''}`}
                onClick={() => selectPreset(p.id)}
              >
                <span className="plugin-preset-card-head">
                  <strong className="plugin-preset-card-title">{p.title}</strong>
                  <span className={`plugin-preset-badge${suiteTitle ? ' is-suite' : ''}`}>
                    {suiteTitle === p.title ? '套件方案' : suiteTitle ?? '我的组合'}
                  </span>
                </span>
                {p.description && <span className="muted plugin-preset-card-desc">{p.description}</span>}
                <span className="plugin-preset-card-foot">
                  <span>{p.plugins.length} 项功能</span>
                  {p.layout && <span className="plugin-preset-layout-tag">含工作台安排</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {!presets.length && <p className="muted">还没有可用方案，可保存当前选择或安装套件。</p>}
      {selected && !editor && <div className="settings-subnav preset-mode" role="group" aria-label="组合应用方式">
        <button type="button" disabled={disabled} aria-pressed={mode === 'add'} onClick={() => setMode('add')}>补充到当前</button>
        <button type="button" disabled={disabled} aria-pressed={mode === 'replace'} onClick={() => setMode('replace')}>整套切换</button>
      </div>}
      {selected && !editor && !shown && (currentPreview?.error
        ? <p className="plugin-presets-error" role="alert">{currentPreview.error} <button className="small" onClick={() => setAttempt(n => n + 1)}>重试预览</button></p>
        : <p className="muted" role="status">正在比较插件选择…</p>)}

      {shown && !editor && (
        <div className="plugin-presets-preview" data-preset-preview={id}>
          {shown.issues.length > 0 && (
            <div role="alert" className="plugin-presets-error">
              <strong>采用方案前需处理</strong>
              {shown.issues.map(i => <p key={i}>{i}</p>)}
            </div>
          )}
          {requiredVersions.map(versionPicker)}
          {changes.length > 0 ? <details className="plugin-presets-changes">
            <summary>拟{changeSummary}</summary>
            <ul>
              {changes.map(c => (
                <li key={c.id}>
                  <span className={c.enabled ? 'preset-change-on' : 'preset-change-off'}>拟{c.action}</span>{' '}
                  {c.title}
                  {c.version ? ` ${c.version}` : ''}
                  {c.previousVersion && c.previousVersion !== c.version ? `（原 ${c.previousVersion}）` : ''}
                  {c.dependency ? ' · 必需依赖' : ''}
                </li>
              ))}
            </ul>
          </details> : <p className="muted">相对于当前勾选，没有启停变化。</p>}
          {(otherVersions.length > 0 || shown.warnings.length > 0) && <details className="plugin-presets-versions"
            open={versionsOpen} onToggle={e => setVersionsOpen(e.currentTarget.open)}>
            <summary>版本与说明{shown.warnings.length > 0 && ` · ${shown.warnings.length} 条提示`}</summary>
            {shown.warnings.map(w => <p className="muted" key={w}>{w}</p>)}
            {otherVersions.map(versionPicker)}
          </details>}
          {selected?.layout && (
            <label>
              <input
                type="checkbox"
                checked={withLayout}
                onChange={e => setWithLayout(e.target.checked)}
              />
              应用配套工作台安排（保留已有页面）
            </label>
          )}
          {dirty && <p className="muted">确认后将替换当前待应用草稿。</p>}
          <button
            className="small primary"
            disabled={disabled || !!shown.issues.length}
            onClick={() =>
              void run(async () => {
                await onUse(
                  shown,
                  withLayout && selected?.layout
                    ? { title: selected.title, layout: selected.layout }
                    : undefined
                )
                setNotice(shown.changes.length || dirty || (withLayout && selected?.layout) ? '方案已暂存，可继续调整启停功能。' : '当前勾选已符合方案。')
              })
            }
          >
            {dirty ? '确认替换待应用选择' : '采用此方案'}
          </button>
        </div>
      )}

      {selected && !editor && (
        <div className="plugin-presets-selected-box">
          {selected.layout && (
            <details className="plugin-presets-layout-details">
              <summary>配套工作台安排</summary>
              <WorkbenchPresetPreview layout={selected.layout} service={workbench} />
              <p className="muted">预览以当前运行的插件为准；启用所需插件后会再次检查。</p>
            </details>
          )}
          <div className="plugin-presets-meta-bar">
            <details className="plugin-presets-members">
              <summary>组合包含 {selected.plugins.length} 项功能</summary>
              <ul>
                {selected.plugins.map(p => (
                  <li key={p.id}>
                    {p.title}
                    {p.version ? ` · 保存时 ${p.version}` : ''}
                  </li>
                ))}
              </ul>
            </details>
            <div className="plugin-presets-actions">
              <button className="small" disabled={disabled} onClick={() => edit('copy')}>
                另存副本…
              </button>
              {selected.editable !== false && (
                <>
                  <button className="small" disabled={disabled} onClick={() => edit('rename')}>
                    重命名
                  </button>
                  <button className="small" disabled={disabled} onClick={() => edit('update')}>
                    更新为当前选择…
                  </button>
                  <button className="small" disabled={disabled} onClick={() => edit('remove')}>
                    删除组合…
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {editor && (
        <form
          className="plugin-presets-editor"
          onSubmit={e => {
            e.preventDefault()
            void save()
          }}
        >
          <strong>
            {editor === 'copy'
              ? '另存方案副本（保留配套布局）'
              : editor === 'save'
                ? '保存当前选择'
                : editor === 'rename'
                  ? '重命名组合'
                  : editor === 'update'
                    ? `更新「${editingPreset.current?.title}」？`
                    : `删除「${editingPreset.current?.title}」？`}
          </strong>
          {editor === 'save' || editor === 'rename' || editor === 'copy' ? (
            <input
              aria-label="组合名称"
              autoFocus
              maxLength={80}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如：阅读与整理"
            />
          ) : (
            <p className="muted">
              {editor === 'update'
                ? '用当前勾选覆盖组合（含未应用草稿）。'
                : '仅删除这份搭配，不停用或卸载插件。'}
            </p>
          )}
          {(editor === 'save' || editor === 'update') && (
            <label>
              <input
                type="checkbox"
                checked={captureLayout}
                onChange={e => {
                  setCaptureLayout(e.target.checked)
                  setRemoveLayout(false)
                }}
              />
              一并保存当前工作台安排
            </label>
          )}
          {editor === 'update' && editingPreset.current?.layout && !captureLayout && (
            <label>
              <input
                type="checkbox"
                checked={!removeLayout}
                onChange={e => setRemoveLayout(!e.target.checked)}
              />
              保留原配套工作台安排
            </label>
          )}
          {editor === 'save' && dirty && <p className="muted">将保存当前待应用的勾选草稿。</p>}
          <div className="plugin-presets-actions">
            <button type="button" className="small" disabled={disabled} onClick={() => setEditor(undefined)}>
              取消
            </button>
            <button
              className={editor === 'remove' ? 'small package-danger' : 'small primary'}
              disabled={
                disabled || ((editor === 'save' || editor === 'rename' || editor === 'copy') && !name.trim())
              }
            >
              {editor === 'remove' ? '确认删除' : editor === 'update' ? '确认更新' : '保存组合'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="plugin-presets-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </section>
  )
}
