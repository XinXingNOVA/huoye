import { useState } from 'react'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { Button, SegmentedControl, Select } from '../../../plugin-api/ui/kit'
import type { RuntimeInfo } from '../../../shared/shared-runtimes'
import type { ProviderChoice } from '../../../shared/capability-status'
import { hostLabel, uiText } from '../../../shared/i18n/interface-display'
import { SettingGroup, SettingRow } from './ui-primitives'

export function ProviderSettings({ library }: { library: boolean }) {
  const [scope, setScope] = useState<'application' | 'library'>('application')
  const [rows, setRows] = useState<ProviderChoice[]>([])
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useUiEffect(display => {
    let revision = 0
    const refresh = () => {
      const ticket = ++revision
      void Promise.all([window.bridge.providers.list(), window.bridge.providers.runtimes()]).then(([next, packages]) => {
        if (ticket === revision) { setRows(next); setRuntimes(packages); setError('') }
      }, e => { if (ticket === revision) setError(String(e)) })
    }
    refresh()
    display.onWindow('focus', refresh)
    const offPackages = window.bridge.packages.onChanged(refresh)
    const offProviders = window.bridge.providers.onChanged(refresh)
    return () => { revision++; offPackages(); offProviders() }
  }, [])
  const run = async (action: () => Promise<void>) => {
    setSaving(true)
    try { setError(''); await action() }
    catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }
  const pendingReload = library && rows.some(row => row.pendingReload)
  const titles: Record<string, string> = { 'media.inspect@1': uiText('媒体信息'), 'audio.waveform@1': uiText('音频波形'), 'media.subtitle@1': uiText('内封字幕') }
  return <><SettingGroup title={uiText('计算引擎')} description={uiText('选择本机处理各项能力的引擎。打开或重载仓库时生效，所选插件须已在对应仓库启用。')}
    action={library && <Button variant={pendingReload ? 'primary' : 'default'} disabled={saving} onClick={() => void run(() => window.bridge.vaults.reload())}>{uiText('重载当前仓库')}</Button>}>
    {pendingReload && <p className="muted" role="status">{uiText('引擎选择已保存，重载后在当前仓库生效。')}</p>}
    {library && <SettingRow title={uiText('引擎选择范围')}><SegmentedControl label={uiText('引擎选择范围')} value={scope}
      options={[{ value: 'application', label: uiText('应用默认') }, { value: 'library', label: uiText('本库覆盖') }]}
      onChange={v => setScope(v === 'library' ? 'library' : 'application')} /></SettingRow>}
    {rows.map(row => {
      const chosen = scope === 'library' ? row.override : row.preferred
      const automatic = row.builtin ? uiText('自动选择（内置优先）') : uiText('自动选择本地引擎')
      return <SettingRow key={row.id} title={titles[row.id] ?? row.id}
      description={row.current ? uiText('本库当前：{value}', { value: row.current.state === 'ready' ? row.current.provider : row.optional && !row.current.provider && row.current.reason === '没有可用实现' ? uiText('可选，未配置') : hostLabel(row.current.reason) }) : undefined}>
      <Select aria-label={titles[row.id] ?? row.id} value={chosen ?? ''} disabled={saving} onChange={e => { const id = e.currentTarget.value; void run(() => window.bridge.providers.set(row.id, id || null, scope)) }}>
        <option value="">{scope === 'library' ? uiText('跟随应用默认') : automatic}</option>
        {scope === 'library' && <option value="@auto">{automatic}</option>}
        {chosen && chosen !== '@auto' && !row.options.some(p => p.id === chosen) && <option value={chosen}>{chosen} · {uiText('不可用')}</option>}
        {row.options.map(p => <option key={p.id} value={p.id}>{p.title} ({p.id})</option>)}
      </Select>
    </SettingRow>})}
  </SettingGroup>
  <SettingGroup title={uiText('共享运行包')} description={uiText('启用后，所有新打开或重载的仓库可共用相应程序。')}
    action={<Button disabled={saving} onClick={() => void run(() => window.bridge.providers.installRuntime())}>{uiText('安装共享运行包')}</Button>}>
    {runtimes.map(pkg => <SettingRow key={pkg.digest} title={pkg.id + ' ' + pkg.version}
      description={[pkg.target, pkg.programs.join(', '), (pkg.bytes / 1048576).toFixed(1) + ' MiB', pkg.digest.slice(0, 8),
        pkg.enabled ? uiText('已启用') : uiText('已停用'), pkg.inUse && uiText('已有仓库正在使用'), pkg.brokenFiles && uiText('需要重新安装：{value}', { value: pkg.brokenFiles.join(', ') })].filter(Boolean).join(' · ')}>
      <Button disabled={saving} onClick={() => void run(() => window.bridge.providers.enableRuntime(pkg.digest, !pkg.enabled))}>{pkg.enabled ? uiText('停用') : uiText('启用')}</Button>
      <Button disabled={saving || pkg.enabled || pkg.inUse} onClick={() => void run(() => window.bridge.providers.removeRuntime(pkg.digest))}>{uiText('移除')}</Button>
    </SettingRow>)}
    {error && <p className="package-error" role="alert">{error}</p>}
  </SettingGroup></>
}
