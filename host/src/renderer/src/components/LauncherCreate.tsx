import type { SpaceInfo } from '../../../shared/file-spaces'
import type { StartingPresetModel } from './use-starting-preset'
import { SettingGroup, SettingRow } from './ui-primitives'
import { isEnter } from '../widgets'

export function LauncherCreate({ name, parent, space, model, busy, onName, onParent, onSpace, onBrowse, onSelect, onCreate, onError }: {
  name: string; parent: string; space?: SpaceInfo; model: StartingPresetModel; busy: boolean
  onName(value: string): void; onParent(value: string): void; onSpace(value?: SpaceInfo): void
  onSelect(id: string): void; onBrowse(): void; onCreate(): void; onError(error: string): void
}) {
  const path = parent.replace(/[\\/]$/, '') + (parent.includes('\\') ? '\\' : '/') + name.trim()
  const preview = model.preview
  const starters = model.presets.filter(p => p.source?.kind === 'suite' && p.source.bundled)
  const choices = [...starters, { id: '', title: '空白底座' }]
  const selected = model.selected
  if (selected && !choices.some(p => p.id === selected.id)) choices.push(selected)
  return <section className="launcher-create launcher-primary-card" aria-label="新建仓库">
    <header><h1 tabIndex={-1}>新建仓库</h1><p className="muted">选择保存位置与起始方案。</p></header>
    <SettingGroup className="launcher-card">
      <SettingRow title={<label htmlFor="launcher-name">仓库名称</label>}>
        <input id="launcher-name" className="field-text" autoFocus placeholder="例如：影视参考" value={name} disabled={busy}
          onChange={e => onName(e.target.value)} onKeyDown={e => { if (isEnter(e)) onCreate() }} />
      </SettingRow>
      <SettingRow title="存放位置" description={<div className="launcher-location" role="status">
        <span>{name.trim() ? '将创建于' : '父文件夹'}</span>
        <span className="launcher-location-path" title={name.trim() ? path : parent}>
          {parent ? '\u200e' + (name.trim() ? path : parent) : '正在读取默认位置…'}
        </span>
      </div>}>
        <button className="small" disabled={busy} onClick={async () => {
          try { const next = await window.bridge.vaults.pick('parent'); if (next) onParent(next) }
          catch (e) { onError(String(e)) }
        }}>选择位置…</button>
      </SettingRow>
      <SettingRow title="文件空间" description={space ? `${space.name} · ${space.mode === 'shared' ? '共享' : '独享'}` : '随仓库创建独享空间'}>
        <button className="small" disabled={busy} onClick={async () => {
          try { const next = await window.bridge.spaces.pick(); if (next) onSpace(next) }
          catch (e) { onError(String(e)) }
        }}>选择已有空间…</button>
        {space && <button className="small" disabled={busy} onClick={() => onSpace(undefined)}>恢复默认</button>}
      </SettingRow>
      <SettingRow title="起始方案" description={<>
        <div className="launcher-starters" role="group" aria-label="起始方案">
          {choices.map(p => <button type="button" key={p.id} aria-pressed={(model.selected?.id ?? '') === p.id}
            disabled={busy} onClick={() => onSelect(p.id)}>{p.title}</button>)}
        </div>
        {preview ? model.selected?.description || (model.selected ? `${preview.selection.external.length} 个外部插件` : '仅启用核心功能，之后可按需添加插件。')
          : model.error || '正在检查方案…'}
      </>}>
        <button className="small" disabled={busy} onClick={onBrowse}>更多方案…</button>
      </SettingRow>
    </SettingGroup>
    {model.error && <p role="alert" className="package-error">{model.error}</p>}
    {!!preview?.issues.length && <div role="alert" className="launcher-error">{preview.issues.map(i => <p key={i}>{i}</p>)}<button className="small" disabled={busy} onClick={onBrowse}>检查方案…</button></div>}
    {!!preview?.warnings.length && <details className="muted"><summary>方案提示 · {preview.warnings.length} 项</summary>{preview.warnings.map(w => <p key={w}>{w}</p>)}</details>}
    <footer className="launcher-create-footer">
      <span className="muted">进入仓库后仍可调整功能与布局。</span>
      <button className="primary launcher-create-btn" disabled={!name.trim() || !parent.trim() || busy || !preview || !!preview.issues.length} onClick={onCreate}>
        {busy ? '正在准备仓库…' : '创建并打开'}
      </button>
    </footer>
  </section>
}
